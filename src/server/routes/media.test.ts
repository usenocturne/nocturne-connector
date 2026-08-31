import { describe, expect, test } from "bun:test";
import type { HostBridgeCallOptions, HostBridgeClient } from "../platform/host-bridge";
import {
  SystemMediaService,
  type SystemMediaPreferenceStore,
} from "../services/system-media-service";
import { createMediaRoutes } from "./media";

class FakeHostBridge implements HostBridgeClient {
  async call<TResult = unknown>(
    _method: string,
    _params?: unknown,
    _options?: HostBridgeCallOptions,
  ): Promise<TResult> {
    return {} as TResult;
  }

  onEvent<T = unknown>(_topic: string, _listener: (data: T) => void): () => void {
    return () => {};
  }

  close(): void {}
}

class MemoryPreferenceStore implements SystemMediaPreferenceStore {
  constructor(private enabled: boolean) {}
  load(): boolean { return this.enabled; }
  save(enabled: boolean): void { this.enabled = enabled; }
}

describe("system media routes", () => {
  test("reports and persists the Windows media preference", async () => {
    const service = new SystemMediaService(
      new FakeHostBridge(),
      { async sendEvent() {}, async sendVolume() {} },
      new MemoryPreferenceStore(true),
    );
    const app = createMediaRoutes(service);

    const initial = await app.handle(new Request("http://localhost/api/media/status"));
    expect(await initial.json()).toEqual({
      supported: true,
      enabled: true,
      forced: false,
      active: false,
    });

    const changed = await app.handle(new Request("http://localhost/api/media/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }));
    expect(await changed.json()).toEqual({
      supported: true,
      enabled: false,
      forced: false,
      active: false,
    });
  });

  test("does not expose Windows media endpoints on the Pi", async () => {
    const response = await createMediaRoutes(null).handle(new Request(
      "http://localhost/api/media/enabled",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    ));
    expect(response.status).toBe(404);
  });
});
