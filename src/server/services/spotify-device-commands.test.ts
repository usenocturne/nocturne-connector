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

const commandUrl = (deviceId: string) =>
  `https://gue1-spclient.spotify.com/connect-state/v1/player/command/from/${deviceId}/to/${deviceId}`;

describe("Spotify commands without a wire device id", () => {
  const cases: Array<[string, (service: SpotifyService) => Promise<unknown>]> = [
    ["playback speed", (service) => service.handleSetPlaybackSpeed({ speed: 1.5 })],
    ["DJ start", (service) => service.handleDjStart({})],
    ["DJ signal", (service) => service.handleDjSignal({ signal: "jump", payload: null })],
  ];

  for (const [name, run] of cases) {
    test(`${name} targets the active Connect device`, async () => {
      const requests: Request[] = [];
      recordRequests(requests);
      const service = serviceWithToken();
      service.setActiveDeviceId("active-device");

      await run(service);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(commandUrl("active-device"));
    });

    test(`${name} fails instead of commanding a placeholder device`, async () => {
      const requests: Request[] = [];
      recordRequests(requests);

      await expect(run(serviceWithToken())).rejects.toThrow("No active device");
      expect(requests).toHaveLength(0);
    });
  }
});

describe("Spotify command results", () => {
  const commands: Array<[string, (service: SpotifyService) => Promise<any>]> = [
    ["seek", (service) => service.handleSeek({ position_ms: 1000 })],
    ["volume", (service) => service.handleVolume({ volume_percent: 40 })],
    ["shuffle", (service) => service.handleShuffle({ state: true })],
    ["repeat track", (service) => service.handleRepeat({ state: "track" })],
    ["repeat off", (service) => service.handleRepeat({ state: "off" })],
    ["playback speed", (service) => service.handleSetPlaybackSpeed({ speed: 1.5 })],
    ["DJ start", (service) => service.handleDjStart({})],
    ["DJ signal", (service) => service.handleDjSignal({ signal: "jump", payload: null })],
  ];

  for (const [name, run] of commands) {
    test(`${name} reports failure when Spotify rejects the command`, async () => {
      recordRequests([], 404);
      const service = serviceWithToken();
      service.setActiveDeviceId("active-device");
      expect((await run(service)).success).toBeFalse();
    });

    test(`${name} reports success when Spotify accepts the command`, async () => {
      recordRequests([], 204);
      const service = serviceWithToken();
      service.setActiveDeviceId("active-device");
      expect((await run(service)).success).toBeTrue();
    });
  }
});

describe("Spotify queue jump", () => {
  test("carries a camelCase contextUri into the skip metadata", async () => {
    const requests: Request[] = [];
    recordRequests(requests);
    const service = serviceWithToken();
    service.setActiveDeviceId("active-device");

    await service.handleNext({ uid: "queue-uid", contextUri: "spotify:album:abc" });

    const body = await requests[0].json();
    expect(body.command.track.metadata.context_uri).toBe("spotify:album:abc");
    expect(body.command.track.metadata.entity_uri).toBe("spotify:album:abc");
  });
});
