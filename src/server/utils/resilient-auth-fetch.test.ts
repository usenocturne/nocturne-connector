import { describe, expect, test } from "bun:test";
import { createClient, type AuthChangeEvent } from "@supabase/supabase-js";
import { createResilientAuthFetch } from "./resilient-auth-fetch";

const REFRESH_URL =
  "https://sb.usenocturne.com/auth/v1/token?grant_type=refresh_token";

function responseFetch(status: number): typeof globalThis.fetch {
  const fetcher = async (): Promise<Response> =>
    new Response(JSON.stringify({ status }), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  return Object.assign(fetcher, {
    preconnect: (_url: string | URL) => undefined,
  });
}

function jwt(expiresAt: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "user-1",
    aud: "authenticated",
    exp: expiresAt,
  })}.${encode({ signature: true })}`;
}

describe("createResilientAuthFetch", () => {
  for (const status of [408, 425, 429, 500, 501, 505, 599]) {
    test(`turns refresh HTTP ${status} into a retryable fetch failure`, async () => {
      const fetcher = createResilientAuthFetch(responseFetch(status));

      const response = await fetcher(REFRESH_URL);
      expect(response.status).toBe(503);
    });
  }

  test("preserves definitive refresh responses", async () => {
    const response = await createResilientAuthFetch(responseFetch(400))(REFRESH_URL);
    expect(response.status).toBe(400);
  });

  test("does not alter non-auth API responses", async () => {
    const response = await createResilientAuthFetch(responseFetch(500))(
      "https://sb.usenocturne.com/rest/v1/spotify_credentials"
    );
    expect(response.status).toBe(500);
  });

  test("makes auth-js retry an HTTP 500 without emitting SIGNED_OUT", async () => {
    let requestCount = 0;
    const rotatedAccessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
    const upstreamFetch = responseFetch(200);
    const baseFetch = Object.assign(
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
            user: {
              id: "user-1",
              aud: "authenticated",
              role: "authenticated",
              email: "user-1@example.com",
              app_metadata: {},
              user_metadata: {},
              created_at: "2026-01-01T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
      { preconnect: upstreamFetch.preconnect }
    );
    const client = createClient("https://sb.usenocturne.com", "test-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: createResilientAuthFetch(baseFetch) },
    });
    const events: AuthChangeEvent[] = [];
    const { data: subscriptionData } = client.auth.onAuthStateChange((event) => {
      events.push(event);
    });

    const result = await client.auth.setSession({
      access_token: jwt(Math.floor(Date.now() / 1000) - 60),
      refresh_token: "initial-refresh-token",
    });
    subscriptionData.subscription.unsubscribe();

    expect(result.error).toBeNull();
    expect(result.data.session?.refresh_token).toBe("rotated-refresh-token");
    expect(requestCount).toBe(2);
    expect(events).toContain("TOKEN_REFRESHED");
    expect(events).not.toContain("SIGNED_OUT");
  });
});
