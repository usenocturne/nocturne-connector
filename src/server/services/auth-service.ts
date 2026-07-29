import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, AUTH_SESSION_PATH } from "../config";
import { createLogger } from "../utils/logger";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { createResilientAuthFetch } from "../utils/resilient-auth-fetch";

const log = createLogger("AuthService");

interface AuthOperationError {
  message: string;
  status?: number;
  code?: string;
  name?: string;
  cause?: unknown;
}

interface AuthClient {
  onAuthStateChange(
    callback: (event: AuthChangeEvent, session: Session | null) => void
  ): { data: { subscription: { unsubscribe: () => void } } };
  setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<{ data: { session: Session | null }; error: AuthOperationError | null }>;
  signOut(options?: {
    scope?: "global" | "local" | "others";
  }): Promise<{ error: AuthOperationError | null }>;
}

interface SavedSession {
  access_token: string;
  refresh_token: string;
}

export interface AuthServiceDependencies {
  authClient?: AuthClient;
  supabaseClient?: SupabaseClient;
  baseFetch?: typeof globalThis.fetch;
  sessionPath?: string;
  restoreRetryBaseDelayMs?: number;
  persistSessionFile?: (path: string, data: string) => void;
}

export function writeSessionFileAtomically(path: string, data: string): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;

  try {
    writeFileSync(temporaryPath, data, { mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (err) {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        log.warn(`Failed to remove temporary session file: ${cleanupError}`);
      }
    }
    throw err;
  }
}

const TRANSIENT_CODES = new Set([
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const TRANSIENT_PATTERNS = [
  "cert_not_yet_valid",
  "certificate is not yet valid",
  "cert has expired",
  "enotfound",
  "econnrefused",
  "econnreset",
  "enetunreach",
  "eai_again",
  "etimedout",
  "fetch failed",
  "network request failed",
  "socket hang up",
  "und_err",
];

const DEFINITIVE_PATTERNS = [
  "refresh_token_not_found",
  "refresh_token_already_used",
  "invalid_grant",
  "invalid_token",
  "session_not_found",
  "user_not_found",
  "invalid refresh token",
];

function extractErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === "object" && typeof cause.code === "string") return cause.code;
  return "";
}

export function isTransientAuthError(err: unknown): boolean {
  if (!err) return false;
  const code = extractErrorCode(err);
  if (code && TRANSIENT_CODES.has(code)) return true;
  const name = (err as { name?: string })?.name ?? "";
  if (name === "AuthRetryableFetchError") return true;
  const status = (err as { status?: number })?.status;
  if (typeof status === "number" && (status === 0 || status === 429 || status >= 500)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

export function isDefinitiveAuthError(err: unknown): boolean {
  if (!err) return false;
  const code = extractErrorCode(err).toLowerCase();
  if (DEFINITIVE_PATTERNS.includes(code)) return true;
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403 || status === 400) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (DEFINITIVE_PATTERNS.some((p) => msg.includes(p))) return true;
    if (status === 401 || status === 403) return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return DEFINITIVE_PATTERNS.some((p) => msg.includes(p));
}

export class AuthService {
  private supabase: SupabaseClient | null;
  private authClient: AuthClient;
  private sessionPath: string;
  private restoreRetryBaseDelayMs: number;
  private persistSessionFile: (path: string, data: string) => void;
  private _currentUser: User | null = null;
  private _session: Session | null = null;
  private _isInitializing = true;
  private stateChangeCallbacks: ((user: User | null) => void)[] = [];
  private supabaseSubscription: { unsubscribe: () => void } | null = null;
  private restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreCancelled = false;
  private restoreGeneration = 0;
  private runtimeRecoveryActive = false;
  private explicitSignOut = false;
  private authEventGeneration = 0;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private persistRetryAttempt = 0;

  constructor(dependencies: AuthServiceDependencies = {}) {
    if (dependencies.authClient) {
      this.supabase = dependencies.supabaseClient ?? null;
      this.authClient = dependencies.authClient;
    } else {
      this.supabase =
        dependencies.supabaseClient ??
        createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
          global: {
            fetch: createResilientAuthFetch(dependencies.baseFetch ?? globalThis.fetch),
          },
        });
      this.authClient = this.supabase.auth;
    }
    this.sessionPath = dependencies.sessionPath ?? AUTH_SESSION_PATH;
    this.restoreRetryBaseDelayMs = dependencies.restoreRetryBaseDelayMs ?? 5_000;
    this.persistSessionFile = dependencies.persistSessionFile ?? writeSessionFileAtomically;
    this.setupAuthStateListener();
  }

  async initialize(): Promise<void> {
    await this.restoreSession();
  }

  get currentUser(): User | null {
    return this._currentUser;
  }

  get session(): Session | null {
    return this._session;
  }

  get isInitializing(): boolean {
    return this._isInitializing;
  }

  get client(): SupabaseClient {
    if (!this.supabase) {
      throw new Error("Supabase client is unavailable when AuthService uses an injected auth client");
    }
    return this.supabase;
  }

  onAuthStateChange(callback: (user: User | null) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  private notifyStateChange(): void {
    for (const cb of this.stateChangeCallbacks) {
      cb(this._currentUser);
    }
  }

  private setupAuthStateListener(): void {
    const { data } = this.authClient.onAuthStateChange((event, session) => {
      const wasExplicitSignOut = this.explicitSignOut;
      const recoveryWasActive = this.runtimeRecoveryActive;
      const eventGeneration = this.authEventGeneration;
      setTimeout(() => {
        if (eventGeneration !== this.authEventGeneration || wasExplicitSignOut) return;
        if (event === "TOKEN_REFRESHED" && session) {
          log.info("Supabase token auto-refreshed, persisting new session");
          this.runtimeRecoveryActive = false;
          this.cancelRestoreRetry();
          this._session = session;
          this._currentUser = session.user;
          this.persistSession(true);
        } else if (event === "SIGNED_OUT") {
          if (recoveryWasActive) return;
          this.recoverUnexpectedSignOut();
        }
      }, 0);
    });
    this.supabaseSubscription = data.subscription;
  }

  destroy(): void {
    this.restoreCancelled = true;
    this.authEventGeneration++;
    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
      this.restoreRetryTimer = null;
    }
    this.cancelPersistRetry();
    this.supabaseSubscription?.unsubscribe();
    this.supabaseSubscription = null;
    void this.supabase?.auth.stopAutoRefresh();
  }

  private async restoreSession(): Promise<void> {
    const saved = this.readPersistedSession();
    if (!saved) {
      this._isInitializing = false;
      this.notifyStateChange();
      return;
    }

    const generation = ++this.restoreGeneration;
    await this.attemptRestore(saved, 0, generation, "initial");
  }

  private readPersistedSession(): SavedSession | null {
    if (!existsSync(this.sessionPath)) return null;

    try {
      const raw = readFileSync(this.sessionPath, "utf-8");
      const saved = JSON.parse(raw) as Partial<SavedSession>;
      if (!saved.access_token || !saved.refresh_token) {
        log.warn("Persisted session is missing tokens; ignoring");
        return null;
      }
      return { access_token: saved.access_token, refresh_token: saved.refresh_token };
    } catch (err) {
      log.warn(`Persisted session file is unreadable; ignoring: ${err}`);
      return null;
    }
  }

  private recoverUnexpectedSignOut(): void {
    if (this.runtimeRecoveryActive || this.restoreCancelled) return;

    const saved = this.readPersistedSession();
    if (!saved) {
      log.warn("Supabase signed out unexpectedly and no persisted session is available");
      this.clearAuthenticatedState();
      return;
    }

    log.warn("Supabase signed out unexpectedly; retaining local identity while restoring the session");
    this.runtimeRecoveryActive = true;
    this._session = null;
    const generation = ++this.restoreGeneration;
    void this.attemptRestore(saved, 0, generation, "runtime");
  }

  private async attemptRestore(
    saved: SavedSession,
    attempt: number,
    generation: number,
    mode: "initial" | "runtime"
  ): Promise<void> {
    if (this.restoreCancelled || generation !== this.restoreGeneration) return;

    try {
      const { data: sessionData, error } = await this.authClient.setSession({
        access_token: saved.access_token,
        refresh_token: saved.refresh_token,
      });

      if (this.restoreCancelled || generation !== this.restoreGeneration) return;

      if (!error && sessionData.session) {
        this._session = sessionData.session;
        this._currentUser = sessionData.session.user;
        this.runtimeRecoveryActive = false;
        this.persistSession(true);
        const suffix = attempt > 0 ? ` (after ${attempt} retries)` : "";
        log.info(`Restored session for user: ${this._currentUser.id}${suffix}`);
        this._isInitializing = false;
        this.notifyStateChange();
        return;
      }

      if (isDefinitiveAuthError(error)) {
        log.warn(`Persisted session rejected by Supabase: ${error?.message ?? "unknown"}`);
        this.finishFailedRestore(mode);
        return;
      }

      const reason = error?.message ?? "no session returned";
      log.warn(`restoreSession attempt ${attempt + 1} returned recoverable error: ${reason} — will retry`);
      this.scheduleRestoreRetry(saved, attempt, generation, mode);
    } catch (err) {
      if (this.restoreCancelled || generation !== this.restoreGeneration) return;

      if (isDefinitiveAuthError(err)) {
        log.warn(`restoreSession definitive failure: ${err}`);
        this.finishFailedRestore(mode);
        return;
      }

      if (isTransientAuthError(err)) {
        log.warn(`restoreSession attempt ${attempt + 1} transient (network/TLS): ${err} — will retry`);
        this.scheduleRestoreRetry(saved, attempt, generation, mode);
        return;
      }

      log.warn(`restoreSession attempt ${attempt + 1} unknown error, treating as transient: ${err}`);
      this.scheduleRestoreRetry(saved, attempt, generation, mode);
    }
  }

  private finishFailedRestore(mode: "initial" | "runtime"): void {
    this.runtimeRecoveryActive = false;
    if (mode === "runtime") {
      this.clearAuthenticatedState();
      return;
    }
    this._isInitializing = false;
    this.notifyStateChange();
  }

  private clearAuthenticatedState(): void {
    this.cancelRestoreRetry();
    this._session = null;
    this._currentUser = null;
    this._isInitializing = false;
    this.notifyStateChange();
  }

  private scheduleRestoreRetry(
    saved: SavedSession,
    attempt: number,
    generation: number,
    mode: "initial" | "runtime"
  ): void {
    if (this.restoreCancelled || generation !== this.restoreGeneration) return;
    const delayMs = Math.min(60_000, this.restoreRetryBaseDelayMs * 2 ** Math.min(attempt, 4));
    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
    }
    this.restoreRetryTimer = setTimeout(() => {
      this.restoreRetryTimer = null;
      this.attemptRestore(saved, attempt + 1, generation, mode).catch((err) =>
        log.error(`attemptRestore threw unexpectedly: ${err}`)
      );
    }, delayMs);
  }

  private cancelRestoreRetry(): void {
    this.restoreGeneration++;
    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
      this.restoreRetryTimer = null;
    }
  }

  private persistSession(retryOnFailure: boolean): boolean {
    if (!this._session) return false;
    try {
      this.persistSessionFile(
        this.sessionPath,
        JSON.stringify({
          access_token: this._session.access_token,
          refresh_token: this._session.refresh_token,
        })
      );
      this.cancelPersistRetry();
      return true;
    } catch (err) {
      log.warn(`Failed to persist session: ${err}`);
      if (retryOnFailure) this.schedulePersistRetry();
      return false;
    }
  }

  private schedulePersistRetry(): void {
    if (this.persistRetryTimer || this.restoreCancelled || !this._session) return;
    const delayMs = Math.min(
      60_000,
      this.restoreRetryBaseDelayMs * 2 ** Math.min(this.persistRetryAttempt, 4)
    );
    this.persistRetryAttempt++;
    this.persistRetryTimer = setTimeout(() => {
      this.persistRetryTimer = null;
      this.persistSession(true);
    }, delayMs);
  }

  private cancelPersistRetry(): void {
    if (this.persistRetryTimer) {
      clearTimeout(this.persistRetryTimer);
      this.persistRetryTimer = null;
    }
    this.persistRetryAttempt = 0;
  }

  private clearPersistedSession(): void {
    try {
      if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath);
    } catch (err) {
      log.warn(`Failed to clear persisted session: ${err}`);
    }
  }

  async setSessionFromTokens(
    accessToken: string,
    refreshToken: string
  ): Promise<{ user: User | null; error: string | null }> {
    this.authEventGeneration++;
    const { data, error } = await this.authClient.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      return { user: null, error: error.message };
    }
    this.cancelRestoreRetry();
    this._session = data.session;
    this._currentUser = data.session?.user ?? null;
    this._isInitializing = false;
    if (this._session) {
      if (!this.persistSession(false)) {
        await this.signOut();
        return { user: null, error: "Unable to persist the connector session" };
      }
    }
    this.notifyStateChange();
    return { user: this._currentUser, error: null };
  }

  async signOut(): Promise<{ error: string | null }> {
    this.authEventGeneration++;
    this.cancelRestoreRetry();
    this.cancelPersistRetry();
    this.runtimeRecoveryActive = false;
    this.explicitSignOut = true;
    let signOutError: string | null = null;
    try {
      const { error } = await this.authClient.signOut({ scope: "local" });
      signOutError = error?.message ?? null;
    } catch (err) {
      signOutError = err instanceof Error ? err.message : String(err);
      log.warn(`Supabase local sign-out failed; local state will still be cleared: ${signOutError}`);
    } finally {
      this.explicitSignOut = false;
      this.clearAuthenticatedState();
      this.clearPersistedSession();
    }
    return { error: signOutError };
  }

  async deleteAccount(): Promise<{ error: string | null }> {
    if (!this._currentUser || !this._session) return { error: "Not authenticated" };

    const userId = this._currentUser.id;
    const accessToken = this._session.access_token;

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ userId }),
      });

      if (response.status < 200 || response.status >= 300) {
        if (response.status === 404) {
          return { error: "Account deletion is not yet available. Please try again later." };
        }
        try {
          const body = (await response.json()) as { message?: string; error?: string };
          const message = body.message ?? body.error;
          if (message && message.length > 0) {
            return { error: message };
          }
        } catch (parseError) {
          log.debug(`Delete account error response was not JSON: ${parseError}`);
        }
        return { error: "Unable to delete your account right now." };
      }

      await this.signOut();
      return { error: null };
    } catch (err) {
      log.warn(`Delete account request failed: ${err}`);
      return {
        error: err instanceof Error ? err.message : "Unable to delete your account right now.",
      };
    }
  }

  getStatus(): {
    authenticated: boolean;
    user: Partial<User> | null;
    passwordResetPending: boolean;
    isInitializing: boolean;
  } {
    return {
      authenticated: !!this._currentUser,
      user: this._currentUser
        ? { id: this._currentUser.id, email: this._currentUser.email }
        : null,
      passwordResetPending: false,
      isInitializing: this._isInitializing,
    };
  }
}
