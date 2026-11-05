import { afterEach, describe, expect, test } from "bun:test";
import type { SpotifyService } from "./spotify-service";
import { SpotifyWebSocketService } from "./spotify-websocket";

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  FakeWebSocket.instances = [];
});

describe("Spotify dealer reconnect", () => {
  test("a late close from the replaced socket does not tear down the new one", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ "dealer-g2": ["dealer.example:443"], spclient: ["spclient.example:443"] }),
      { preconnect: (_url: string | URL) => undefined },
    );
    const spotify = {
      getValidAccessToken: async () => "access-token",
      setSpclientEndpoint: () => undefined,
    } as unknown as SpotifyService;
    const errors: Error[] = [];
    const service = new SpotifyWebSocketService(spotify);
    service.setDelegate({
      onPlayerEvent: () => undefined,
      onConnectionStateChange: () => undefined,
      onError: (error) => errors.push(error),
    });

    await service.connect();
    const first = FakeWebSocket.instances[0];
    first.onopen?.();

    await service.reconnect();
    const second = FakeWebSocket.instances[1];
    second.onopen?.();
    expect(service.isConnected).toBeTrue();

    await new Promise((resolve) => setTimeout(resolve, 150));
    first.onclose?.();

    expect(service.isConnected).toBeTrue();
    expect(errors).toHaveLength(0);
    expect(second.closed).toBeFalse();
    service.disconnect();
  });
});
