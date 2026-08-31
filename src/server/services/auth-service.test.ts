import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { AuthService, type SessionProtector } from "./auth-service";

interface FakeAuthError {
  message: string;
  status?: number;
  code?: string;
  name?: string;
}

type SessionResult = {
  data: { session: Session | null };
  error: FakeAuthError | null;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolve) throw new Error("Deferred resolver is unavailable");
      resolve(value);
    },
  };
}

class FakeAuthClient {
  private listener: ((event: AuthChangeEvent, session: Session | null) => void) | null = null;
  readonly sessionResults: (SessionResult | Promise<SessionResult>)[] = [];
  readonly setSessionCalls: { access_token: string; refresh_token: string }[] = [];
  signOutScope: string | null = null;
  signOutEvent: { event: AuthChangeEvent; session: Session | null } = {
    event: "SIGNED_OUT",
    session: null,
  };

  onAuthStateChange(
    callback: (event: AuthChangeEvent, session: Session | null) => void
  ): { data: { subscription: { unsubscribe: () => void } } } {
    this.listener = callback;
    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.listener = null;
          },
        },
      },
    };
  }

  async setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<SessionResult> {
    this.setSessionCalls.push(tokens);
    const result = this.sessionResults.shift();
    if (!result) throw new Error("No fake session result queued");
    return await result;
  }

  async signOut(options?: {
    scope?: "global" | "local" | "others";
  }): Promise<{ error: FakeAuthError | null }> {
    this.signOutScope = options?.scope ?? null;
    this.emit(this.signOutEvent.event, this.signOutEvent.session);
    return { error: null };
  }

  emit(event: AuthChangeEvent, session: Session | null): void {
    this.listener?.(event, session);
  }
}

class FakeSessionProtector implements SessionProtector {
  async protect(value: string): Promise<string> {
    return Buffer.from(value, "utf8").toString("base64");
  }

  async unprotect(value: string): Promise<string> {
    return Buffer.from(value, "base64").toString("utf8");
  }
}

const services: AuthService[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.destroy();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function sessionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nocturne-auth-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "auth-session.json");
}

function user(id = "user-1"): User {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: `${id}@example.com`,
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function session(accessToken: string, refreshToken: string, sessionUser = user()): Session {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: sessionUser,
  };
}

function jwt(expiresAt: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "user-1",
    aud: "authenticated",
    exp: expiresAt,
  })}.${encode({ signature: true })}`;
}

function success(result: Session): SessionResult {
  return { data: { session: result }, error: null };
}

function failure(message: string, status: number, code?: string): SessionResult {
  const error = Object.assign(new Error(message), { status, code, name: "AuthApiError" });
  return { data: { session: null }, error };
}

function createService(authClient: FakeAuthClient, path: string): AuthService {
  const service = new AuthService({
    authClient,
    sessionPath: path,
    restoreRetryBaseDelayMs: 1,
  });
  services.push(service);
  return service;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for auth state");
    await Bun.sleep(1);
  }
}

describe("AuthService", () => {
  test("wires retryable refresh responses into the production Supabase client", async () => {
    const path = await sessionPath();
    let requestCount = 0;
    const rotatedAccessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
    const fetcher = Object.assign(
      async (): Promise<Response> => {
        requestCount++;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: "temporary failure" }), { status: 500 });
        }
        return new Response(
          JSON.stringify({
            access_token: rotatedAccessToken,
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
            token_type: "bearer",
            user: user(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      { preconnect: (_url: string | URL) => undefined }
    );
    const service = new AuthService({ baseFetch: fetcher, sessionPath: path });
    services.push(service);

    const result = await service.setSessionFromTokens(
      jwt(Math.floor(Date.now() / 1000) - 60),
      "initial-refresh-token"
    );

    expect(result.error).toBeNull();
    expect(requestCount).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf-8")).refresh_token).toBe(
      "rotated-refresh-token"
    );
    await Bun.sleep(1);
  });

  test("persists rotated tokens atomically with owner-only permissions", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));

    await service.setSessionFromTokens("pair-access", "pair-refresh");
    authClient.emit("TOKEN_REFRESHED", session("access-2", "refresh-2"));

    await waitFor(() => JSON.parse(readFileSync(path, "utf-8")).refresh_token === "refresh-2");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, "..")).filter((name) => name.startsWith("auth-session.json.tmp."))).toEqual([]);
  });

  test("stores and restores protected sessions through the platform protector", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const protector = new FakeSessionProtector();
    const service = new AuthService({
      authClient,
      sessionPath: path,
      sessionProtector: protector,
    });
    services.push(service);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));

    await service.setSessionFromTokens("pair-access", "pair-refresh");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(typeof persisted.protected_data).toBe("string");
    expect(persisted.access_token).toBeUndefined();

    service.destroy();
    const restoredClient = new FakeAuthClient();
    const restored = new AuthService({
      authClient: restoredClient,
      sessionPath: path,
      sessionProtector: protector,
    });
    services.push(restored);
    restoredClient.sessionResults.push(success(session("access-2", "refresh-2")));
    await restored.initialize();
    expect(restoredClient.setSessionCalls[0]).toEqual({
      access_token: "access-1",
      refresh_token: "refresh-1",
    });
  });

  test("retains identity and retries after an unexpected runtime sign-out", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    const recovery = deferred<SessionResult>();
    authClient.sessionResults.push(success(session("access-1", "refresh-1")), recovery.promise);
    const observedUsers: (string | null)[] = [];
    service.onAuthStateChange((currentUser) => observedUsers.push(currentUser?.id ?? null));

    await service.setSessionFromTokens("pair-access", "pair-refresh");
    authClient.emit("SIGNED_OUT", null);

    await waitFor(() => authClient.setSessionCalls.length === 2);
    expect(service.getStatus().authenticated).toBeTrue();
    expect(observedUsers).not.toContain(null);
    recovery.resolve(success(session("access-2", "refresh-2")));
    await waitFor(() => JSON.parse(readFileSync(path, "utf-8")).refresh_token === "refresh-2");
    expect(JSON.parse(readFileSync(path, "utf-8")).refresh_token).toBe("refresh-2");
    expect(observedUsers).not.toContain(null);
  });

  test("retries persistence after a rotated token write fails", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    let writeCount = 0;
    const service = new AuthService({
      authClient,
      sessionPath: path,
      restoreRetryBaseDelayMs: 1,
      persistSessionFile: (target, data) => {
        writeCount++;
        if (writeCount === 2) throw new Error("temporary disk error");
        writeFileSync(target, data, { mode: 0o600 });
      },
    });
    services.push(service);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));
    await service.setSessionFromTokens("pair-access", "pair-refresh");

    authClient.emit("TOKEN_REFRESHED", session("access-2", "refresh-2"));

    await waitFor(() => writeCount === 3);
    expect(JSON.parse(readFileSync(path, "utf-8")).refresh_token).toBe("refresh-2");
  });

  test("fails pairing when the new session cannot be persisted", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = new AuthService({
      authClient,
      sessionPath: path,
      persistSessionFile: () => {
        throw new Error("read-only data partition");
      },
    });
    services.push(service);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));

    const result = await service.setSessionFromTokens("pair-access", "pair-refresh");

    expect(result.error).toBe("Unable to persist the connector session");
    expect(service.getStatus().authenticated).toBeFalse();
    expect(authClient.signOutScope).toBe("local");
  });

  test("clears identity once when runtime recovery is definitively rejected", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(
      success(session("access-1", "refresh-1")),
      failure("Refresh token has already been used", 400, "refresh_token_already_used")
    );
    const observedUsers: (string | null)[] = [];
    service.onAuthStateChange((currentUser) => observedUsers.push(currentUser?.id ?? null));
    await service.setSessionFromTokens("pair-access", "pair-refresh");

    authClient.emit("SIGNED_OUT", null);

    await waitFor(() => !service.getStatus().authenticated);
    expect(observedUsers.filter((id) => id === null)).toHaveLength(1);
    await Bun.sleep(5);
    expect(authClient.setSessionCalls).toHaveLength(2);
  });

  test("explicit sign-out invalidates an already queued recovery event", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));
    await service.setSessionFromTokens("pair-access", "pair-refresh");

    authClient.emit("SIGNED_OUT", null);
    await service.signOut();
    await Bun.sleep(5);

    expect(service.getStatus().authenticated).toBeFalse();
    expect(authClient.setSessionCalls).toHaveLength(1);
  });

  test("destroy invalidates queued auth events", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));
    await service.setSessionFromTokens("pair-access", "pair-refresh");
    const observedUsers: (string | null)[] = [];
    service.onAuthStateChange((currentUser) => observedUsers.push(currentUser?.id ?? null));

    authClient.emit("TOKEN_REFRESHED", session("access-2", "refresh-2"));
    service.destroy();
    await Bun.sleep(5);

    expect(JSON.parse(readFileSync(path, "utf-8")).refresh_token).toBe("refresh-1");
    expect(observedUsers).toEqual([]);
  });

  test("retries a transient startup restore without exposing pairing", async () => {
    const path = await sessionPath();
    writeFileSync(path, JSON.stringify({ access_token: "saved-access", refresh_token: "saved-refresh" }));
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(
      failure("rate limited", 429),
      success(session("access-2", "refresh-2"))
    );

    await service.initialize();

    expect(service.getStatus().isInitializing).toBeTrue();
    await waitFor(() => service.getStatus().authenticated);
    expect(service.getStatus().isInitializing).toBeFalse();
  });

  test("explicit sign-out is local and clears persisted state", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));
    await service.setSessionFromTokens("pair-access", "pair-refresh");

    const result = await service.signOut();

    expect(result.error).toBeNull();
    expect(authClient.signOutScope).toBe("local");
    expect(service.getStatus().authenticated).toBeFalse();
    expect(existsSync(path)).toBeFalse();
    await Bun.sleep(1);
    expect(authClient.setSessionCalls).toHaveLength(1);
  });

  test("ignores a token refresh event emitted during explicit sign-out", async () => {
    const path = await sessionPath();
    const authClient = new FakeAuthClient();
    const service = createService(authClient, path);
    authClient.sessionResults.push(success(session("access-1", "refresh-1")));
    await service.setSessionFromTokens("pair-access", "pair-refresh");
    authClient.signOutEvent = {
      event: "TOKEN_REFRESHED",
      session: session("access-2", "refresh-2"),
    };

    await service.signOut();
    await Bun.sleep(5);

    expect(service.getStatus().authenticated).toBeFalse();
    expect(existsSync(path)).toBeFalse();
  });
});
