import { SUPABASE_URL } from "../config";
import { createLogger } from "./logger";

const log = createLogger("SupabaseAuthFetch");
const AUTH_TOKEN_PATH = "/auth/v1/token";
const RETRYABLE_AUTH_STATUSES = new Set([408, 425, 429]);

function requestUrl(input: string | URL | Request): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

function isRefreshRequest(input: string | URL | Request): boolean {
  const url = requestUrl(input);
  if (!url) return false;

  const supabaseUrl = new URL(SUPABASE_URL);
  return (
    url.origin === supabaseUrl.origin &&
    url.pathname === AUTH_TOKEN_PATH &&
    url.searchParams.get("grant_type") === "refresh_token"
  );
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_AUTH_STATUSES.has(status) || status >= 500;
}

export function createResilientAuthFetch(
  baseFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  const resilientFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> => {
    const response = await baseFetch(input, init);
    if (isRefreshRequest(input) && isRetryableStatus(response.status)) {
      log.warn(`Supabase token refresh returned retryable HTTP ${response.status}`);
      return new Response(response.body, {
        status: 503,
        statusText: "Service Unavailable",
        headers: response.headers,
      });
    }
    return response;
  };

  return Object.assign(resilientFetch, {
    preconnect: baseFetch.preconnect.bind(baseFetch),
  });
}
