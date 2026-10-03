import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyDatabaseStorage } from "./spotify-database";
import { SpotifyService } from "./spotify-service";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serviceWithToken(): SpotifyService {
  const service = new SpotifyService(new SpotifyDatabaseStorage(), () => "nocturne-user");
  service.getValidAccessToken = async () => "access-token";
  return service;
}

function recordRequests(requests: Request[], status = 200): void {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status });
    },
    { preconnect: (_url: string | URL) => undefined },
  );
}

describe("Spotify wake-devices", () => {
  test("posts an empty wake request to the connect-state cluster", async () => {
    const requests: Request[] = [];
    recordRequests(requests);

    await serviceWithToken().wakeDevices();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe(
      "https://gue1-spclient.spotify.com/connect-state/v1/cluster/wake-devices",
    );
    expect(requests[0].headers.get("authorization")).toBe("Bearer access-token");
    expect(await requests[0].text()).toBe("");
  });

  test("throttles repeated wakes so the switcher refetch does not wake again", async () => {
    const requests: Request[] = [];
    recordRequests(requests);
    const service = serviceWithToken();

    await service.wakeDevices();
    await service.wakeDevices();

    expect(requests).toHaveLength(1);
  });

  test("never rejects when Spotify refuses the wake", async () => {
    recordRequests([], 403);
    await expect(serviceWithToken().wakeDevices()).resolves.toBeUndefined();

    const service = serviceWithToken();
    service.getValidAccessToken = async () => {
      throw new Error("not authenticated");
    };
    await expect(service.wakeDevices()).resolves.toBeUndefined();
  });
});
