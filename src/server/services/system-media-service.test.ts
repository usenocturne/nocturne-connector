import { describe, expect, spyOn, test } from "bun:test";
import type { HostBridgeClient } from "../platform/host-bridge";
import {
  mediaControlAction,
  normalizeNowPlayingUpdate,
  SystemMediaService,
  type SystemMediaPreferenceStore,
  type SystemMediaSink,
} from "./system-media-service";

const NOW_PLAYING_FIXTURE = {
  media_item_attributes: {
    MediaItemTitle: "Night Drive",
    MediaItemArtist: "Nocturne",
    MediaItemAlbumName: "Midnight Signals",
    MediaItemPlaybackDurationInMilliseconds: 181_000,
  },
  playback_attributes: {
    PlaybackStatus: "playing",
    PlaybackShuffleMode: "songs",
    PlaybackRepeatMode: "all",
    PlaybackAppName: "YouTube Music",
    PlaybackElapsedTimeInMilliseconds: 42_500,
    PlaybackRate: 1.25,
  },
  media_generation: 7n,
};

class FakeHostBridge implements HostBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  volumePercent: number | null = null;
  controlStatus: "ok" | "unsupported" | "disabled" = "ok";

  async call<TResult = unknown>(
    method: string,
    params: unknown = {},
  ): Promise<TResult> {
    this.calls.push({ method, params });
    let response: unknown = {};
    if (method === "media.get_volume") {
      response = { volume_percent: this.volumePercent };
    } else if (method === "media.control") {
      response = { status: this.controlStatus };
    }
    return response as TResult;
  }

  onEvent<T = unknown>(topic: string, listener: (data: T) => void): () => void {
    const listeners = this.listeners.get(topic) ?? new Set<(data: unknown) => void>();
    const wrapped = (data: unknown) => listener(data as T);
    listeners.add(wrapped);
    this.listeners.set(topic, listeners);
    return () => listeners.delete(wrapped);
  }

  emit(topic: string, data: unknown): void {
    for (const listener of this.listeners.get(topic) ?? []) listener(data);
  }

  close(): void {}
}

class RecordingSink implements SystemMediaSink {
  readonly deliveries: Array<
    | { kind: "event"; topic: string; data: unknown }
    | { kind: "volume"; volumePercent: number; muted?: boolean }
  > = [];

  async sendEvent(topic: string, data: unknown): Promise<void> {
    this.deliveries.push({ kind: "event", topic, data });
  }

  async sendVolume(volumePercent: number, muted?: boolean): Promise<void> {
    this.deliveries.push({ kind: "volume", volumePercent, muted });
  }
}

class MemoryPreferenceStore implements SystemMediaPreferenceStore {
  readonly saved: boolean[] = [];

  constructor(private enabled: boolean) {}

  load(): boolean {
    return this.enabled;
  }

  save(enabled: boolean): void {
    this.enabled = enabled;
    this.saved.push(enabled);
  }
}

describe("SystemMediaService", () => {
  test("a late successful initial probe cannot overwrite a newer volume update", async () => {
    let finishProbe!: (response: unknown) => void;
    const pendingProbe = new Promise<unknown>((resolve) => { finishProbe = resolve; });
    class StalledVolumeBridge extends FakeHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        if (method === "media.get_volume") return await pendingProbe as TResult;
        return super.call(method, params);
      }
    }
    const host = new StalledVolumeBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink, new MemoryPreferenceStore(false));
    const refresh = spyOn(service as any, "refreshVolume");
    try {
      await service.start();
      expect(service.isVolumeSupported).toBeFalse();
      host.emit("device.volume.update", { volume_percent: 75, muted: true });
      finishProbe({ volume_percent: 30, muted: false });
      await refresh.mock.results[0]!.value;
      await service.whenIdle();
      expect(service.currentVolumePercent).toBe(75);
      expect(service.currentMuted).toBeTrue();
      expect(service.isVolumeSupported).toBeTrue();
      expect(sink.deliveries).toEqual([{ kind: "volume", volumePercent: 75, muted: true }]);
      await service.stop();
    } finally {
      finishProbe({ status: "unsupported" });
      refresh.mockRestore();
    }
  });

  for (const failure of ["unsupported", "error"] as const) {
    test(`a late ${failure} probe preserves volume support recovered while media is disabled`, async () => {
      let finishProbe!: (response: unknown) => void;
      let failProbe!: (error: Error) => void;
      const pendingProbe = new Promise<unknown>((resolve, reject) => {
        finishProbe = resolve;
        failProbe = reject;
      });
      class StalledVolumeBridge extends FakeHostBridge {
        async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
          if (method === "media.get_volume") return await pendingProbe as TResult;
          if (method === "volume.get") return { volume_percent: 42, muted: false } as TResult;
          return super.call(method, params);
        }
      }
      const host = new StalledVolumeBridge();
      const service = new SystemMediaService(host, new RecordingSink(), new MemoryPreferenceStore(false));
      const refresh = spyOn(service as any, "refreshVolume");
      try {
        await service.start(); // Completes while the probe is still pending.
        expect(service.isActive).toBeFalse();
        expect(service.isVolumeSupported).toBeFalse();
        host.emit("device.volume.update", { volume_percent: 35, muted: false });
        expect(service.isVolumeSupported).toBeTrue();
        expect(await service.getVolume()).toEqual({ volume_percent: 42, muted: false });
        if (failure === "error") failProbe(new Error("Native probe failed"));
        else finishProbe({ status: "unsupported" });
        await refresh.mock.results[0]!.value;
        expect(service.isVolumeSupported).toBeTrue();
        expect(service.currentVolumePercent).toBe(42);
        await service.stop();
      } finally {
        finishProbe({ status: "unsupported" });
        refresh.mockRestore();
      }
    });
  }

  test("supports getVolume, setVolume, adjustVolume, and toggleMute volume RPCs", async () => {
    class FakeVolumeHostBridge extends FakeHostBridge {
      vol = 40;
      muted = false;

      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get") {
          return { volume_percent: this.vol, muted: this.muted } as TResult;
        } else if (method === "volume.set") {
          const p = params as { volume_percent: number };
          this.vol = p.volume_percent;
          return { status: "ok", volume_percent: this.vol, muted: this.muted } as TResult;
        } else if (method === "volume.adjust") {
          const p = params as { delta: number };
          this.vol = Math.max(0, Math.min(100, this.vol + p.delta));
          return { status: "ok", volume_percent: this.vol, muted: this.muted } as TResult;
        } else if (method === "volume.toggleMute") {
          const p = params as { muted?: boolean };
          this.muted = p.muted ?? !this.muted;
          return { status: "ok", volume_percent: this.vol, muted: this.muted } as TResult;
        }
        return super.call(method, params);
      }
    }

    const host = new FakeVolumeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();

    // getVolume
    const getRes = await service.getVolume();
    expect(getRes).toEqual({ volume_percent: 40, muted: false });

    // setVolume with clamping
    const setRes = await service.setVolume(120);
    expect(setRes).toEqual({ status: "ok", volume_percent: 100, muted: false });
    expect(host.calls.at(-1)).toEqual({ method: "volume.set", params: { volume_percent: 100 } });

    // adjustVolume
    const adjRes = await service.adjustVolume(-15);
    expect(adjRes).toEqual({ status: "ok", volume_percent: 85, muted: false });

    // toggleMute
    const muteRes = await service.toggleMute();
    expect(muteRes).toEqual({ status: "ok", volume_percent: 85, muted: true });

    await service.stop();
  });

  test("rejects invalid inputs without calling host or altering cached state", async () => {
    class FakeVolumeHostBridge extends FakeHostBridge {
      vol = 50;
      muted = false;

      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get") {
          return { volume_percent: this.vol, muted: this.muted } as TResult;
        }
        return { status: "ok" } as TResult;
      }
    }

    const host = new FakeVolumeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();
    await service.getVolume(); // cache is (50, false)
    host.calls.length = 0;

    // setVolume invalid types
    expect(await service.setVolume(NaN)).toEqual({ status: "unsupported" });
    expect(await service.setVolume("75" as any)).toEqual({ status: "unsupported" });
    expect(host.calls).toHaveLength(0);

    // adjustVolume invalid types
    expect(await service.adjustVolume(Infinity)).toEqual({ status: "unsupported" });
    expect(await service.adjustVolume("10" as any)).toEqual({ status: "unsupported" });
    expect(host.calls).toHaveLength(0);

    // toggleMute invalid types
    expect(await service.toggleMute("yes" as any)).toEqual({ status: "unsupported" });
    expect(host.calls).toHaveLength(0);

    // Cache remains unchanged
    expect(service.currentVolumePercent).toBe(50);
    expect(service.currentMuted).toBeFalse();

    await service.stop();
  });

  test("handles endpoint failures and malformed ok responses without fabricating values or corrupting cache", async () => {
    class FailingVolumeHostBridge extends FakeHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get") {
          return { volume_percent: 45, muted: false } as TResult;
        }
        // Return ok status but missing volume_percent / muted
        return { status: "ok" } as TResult;
      }
    }

    const host = new FailingVolumeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();

    await service.getVolume(); // Cache is 45, false
    expect(service.currentVolumePercent).toBe(45);
    expect(service.currentMuted).toBeFalse();

    // Malformed ok responses should return unsupported without overwriting 45, false
    expect(await service.setVolume(50)).toEqual({ status: "unsupported" });
    expect(await service.adjustVolume(10)).toEqual({ status: "unsupported" });
    expect(await service.toggleMute()).toEqual({ status: "unsupported" });

    expect(service.currentVolumePercent).toBe(45);
    expect(service.currentMuted).toBeFalse();

    await service.stop();
  });

  test("volume RPCs work even when system media playback integration is disabled", async () => {
    class FakeVolumeHostBridge extends FakeHostBridge {
      vol = 30;
      muted = false;

      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get" || method === "media.get_volume") {
          return { volume_percent: this.vol, muted: this.muted } as TResult;
        } else if (method === "volume.set") {
          const p = params as { volume_percent: number };
          this.vol = p.volume_percent;
          return { status: "ok", volume_percent: this.vol, muted: this.muted } as TResult;
        }
        return super.call(method, params);
      }
    }

    const host = new FakeVolumeHostBridge();
    const sink = new RecordingSink();
    const prefs = new MemoryPreferenceStore(false); // disabled
    const service = new SystemMediaService(host, sink, prefs);
    await service.start();

    expect(service.isActive).toBeFalse(); // playback integration inactive
    expect(service.isVolumeSupported).toBeTrue();
    expect(service.currentVolumePercent).toBe(30);
    expect(host.calls).toContainEqual({ method: "media.get_volume", params: {} });
    expect(host.calls.some(({ method }) => method === "media.start")).toBeFalse();

    // Volume commands should still succeed!
    const setRes = await service.setVolume(60);
    expect(setRes).toEqual({ status: "ok", volume_percent: 60, muted: false });
    expect(service.currentVolumePercent).toBe(60);

    await service.stop();
  });

  test("starts the host after registering listeners and reports initial volume", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    host.volumePercent = 37;
    const service = new SystemMediaService(host, sink);

    await service.start();
    await service.whenIdle();

    expect(host.calls).toEqual([
      { method: "media.get_volume", params: {} },
      { method: "media.set_spotify_linked", params: { linked: false } },
      { method: "media.start", params: {} },
    ]);
    expect(service.currentVolumePercent).toBe(37);
    expect(sink.deliveries).toEqual([{ kind: "volume", volumePercent: 37 }]);
    await service.stop();
  });

  test("sends canonical metadata before correlated base64 artwork", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();

    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    host.emit("media.now_playing.artwork", {
      data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      content_type: "image/jpeg",
      media_generation: 7,
    });
    await service.whenIdle();

    expect(sink.deliveries).toEqual([
      {
        kind: "event",
        topic: "media.now_playing.update",
        data: {
          ...NOW_PLAYING_FIXTURE,
          media_generation: 7,
        },
      },
      {
        kind: "event",
        topic: "media.now_playing.artwork",
        data: {
          data: "/9j/2Q==",
          content_type: "image/jpeg",
          media_generation: 7,
        },
      },
    ]);

    sink.deliveries.length = 0;
    await service.replayLatest();
    expect(sink.deliveries.map((delivery) =>
      delivery.kind === "event" ? delivery.topic : delivery.kind,
    )).toEqual([
      "media.now_playing.update",
      "media.now_playing.artwork",
    ]);
    await service.stop();
  });

  test("invalidates old artwork immediately when the generation changes", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();

    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    host.emit("media.now_playing.artwork", {
      data: Uint8Array.from([1]),
      content_type: "image/jpeg",
      media_generation: 7,
    });
    host.emit("media.now_playing.update", {
      ...NOW_PLAYING_FIXTURE,
      media_item_attributes: {
        ...NOW_PLAYING_FIXTURE.media_item_attributes,
        MediaItemTitle: "Second Track",
      },
      media_generation: 8,
    });
    host.emit("media.now_playing.artwork", {
      data: Uint8Array.from([2]),
      content_type: "image/jpeg",
      media_generation: 7,
    });
    await service.whenIdle();

    sink.deliveries.length = 0;
    await service.replayLatest();
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]).toMatchObject({
      kind: "event",
      topic: "media.now_playing.update",
      data: { media_generation: 8 },
    });
    await service.stop();
  });

  test("does not hold newer metadata behind an in-flight artwork transfer", async () => {
    const host = new FakeHostBridge();
    const topics: string[] = [];
    let markArtworkStarted = () => {};
    let releaseArtwork = () => {};
    const artworkStarted = new Promise<void>((resolve) => {
      markArtworkStarted = resolve;
    });
    const artworkGate = new Promise<void>((resolve) => {
      releaseArtwork = resolve;
    });
    const sink: SystemMediaSink = {
      async sendEvent(topic) {
        topics.push(topic);
        if (topic === "media.now_playing.artwork") {
          markArtworkStarted();
          await artworkGate;
        }
      },
      async sendVolume() {},
    };
    const service = new SystemMediaService(host, sink);
    await service.start();

    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    await service.whenIdle();
    host.emit("media.now_playing.artwork", {
      data: Uint8Array.from([1]),
      content_type: "image/jpeg",
      media_generation: 7,
    });
    await artworkStarted;
    host.emit("media.now_playing.update", {
      ...NOW_PLAYING_FIXTURE,
      media_item_attributes: {
        ...NOW_PLAYING_FIXTURE.media_item_attributes,
        MediaItemTitle: "Next Track",
      },
      media_generation: 8,
    });

    expect(topics).toEqual([
      "media.now_playing.update",
      "media.now_playing.artwork",
      "media.now_playing.update",
    ]);
    releaseArtwork();
    await service.whenIdle();
    await service.stop();
  });

  test("suppresses Spotify only while the connector integration is linked", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    const service = new SystemMediaService(host, sink);
    await service.start();
    const spotify = {
      ...NOW_PLAYING_FIXTURE,
      playback_attributes: {
        ...NOW_PLAYING_FIXTURE.playback_attributes,
        PlaybackAppName: " spotify ",
      },
    };

    host.emit("media.now_playing.update", spotify);
    await service.whenIdle();
    expect(sink.deliveries).toHaveLength(1);

    await service.setSpotifyLinked(true);
    sink.deliveries.length = 0;
    host.emit("media.now_playing.update", spotify);
    await service.whenIdle();
    await service.replayLatest();
    expect(sink.deliveries).toEqual([]);

    await service.setSpotifyLinked(false);
    host.emit("media.now_playing.update", spotify);
    await service.whenIdle();
    expect(sink.deliveries).toHaveLength(1);
    expect(host.calls).toContainEqual({
      method: "media.set_spotify_linked",
      params: { linked: true },
    });
    await service.stop();
  });

  test("persists the toggle and emits stopped before disabling media", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    const preferences = new MemoryPreferenceStore(true);
    let now = 10_000;
    const service = new SystemMediaService(host, sink, preferences, () => now);
    await service.start();
    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    await service.whenIdle();
    sink.deliveries.length = 0;
    now += 2_000;

    await service.setSystemMediaEnabled(false);

    expect(preferences.saved).toEqual([false]);
    expect(service.isSystemMediaEnabled).toBeFalse();
    expect(service.isActive).toBeFalse();
    expect(sink.deliveries).toEqual([
      {
        kind: "event",
        topic: "media.now_playing.update",
        data: {
          ...NOW_PLAYING_FIXTURE,
          playback_attributes: {
            ...NOW_PLAYING_FIXTURE.playback_attributes,
            PlaybackStatus: "stopped",
            PlaybackElapsedTimeInMilliseconds: 45_000,
          },
          media_generation: 7,
        },
      },
    ]);
    expect(host.calls.at(-1)).toEqual({ method: "media.stop", params: {} });
    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    await service.replayLatest();
    expect(sink.deliveries).toHaveLength(1);

    await service.setSystemMediaEnabled(true);
    expect(preferences.saved).toEqual([false, true]);
    expect(service.isActive).toBeTrue();
    expect(host.calls.slice(-2)).toEqual([
      { method: "media.set_spotify_linked", params: { linked: false } },
      { method: "media.start", params: {} },
    ]);
    await service.stop();
  });

  test("rebases playing progress for replay without compounding and clamps at duration", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    let now = 10_000;
    const service = new SystemMediaService(
      host,
      sink,
      new MemoryPreferenceStore(true),
      () => now,
    );
    await service.start();
    host.emit("media.now_playing.update", NOW_PLAYING_FIXTURE);
    await service.whenIdle();
    sink.deliveries.length = 0;

    now += 2_000;
    await service.replayLatest();
    await service.replayLatest();
    expect(sink.deliveries.slice(0, 2)).toEqual([
      {
        kind: "event",
        topic: "media.now_playing.update",
        data: {
          ...NOW_PLAYING_FIXTURE,
          playback_attributes: {
            ...NOW_PLAYING_FIXTURE.playback_attributes,
            PlaybackElapsedTimeInMilliseconds: 45_000,
          },
          media_generation: 7,
        },
      },
      {
        kind: "event",
        topic: "media.now_playing.update",
        data: {
          ...NOW_PLAYING_FIXTURE,
          playback_attributes: {
            ...NOW_PLAYING_FIXTURE.playback_attributes,
            PlaybackElapsedTimeInMilliseconds: 45_000,
          },
          media_generation: 7,
        },
      },
    ]);

    sink.deliveries.length = 0;
    now += 10 * 60_000;
    await service.replayLatest();
    expect(sink.deliveries[0]).toMatchObject({
      kind: "event",
      data: {
        playback_attributes: {
          PlaybackElapsedTimeInMilliseconds: 181_000,
        },
      },
    });
    await service.stop();
  });

  test("does not advance paused progress during replay", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    let now = 10_000;
    const service = new SystemMediaService(
      host,
      sink,
      new MemoryPreferenceStore(true),
      () => now,
    );
    await service.start();
    host.emit("media.now_playing.update", {
      ...NOW_PLAYING_FIXTURE,
      playback_attributes: {
        ...NOW_PLAYING_FIXTURE.playback_attributes,
        PlaybackStatus: "paused",
      },
    });
    await service.whenIdle();
    sink.deliveries.length = 0;

    now += 30_000;
    await service.replayLatest();
    expect(sink.deliveries[0]).toMatchObject({
      kind: "event",
      data: {
        playback_attributes: {
          PlaybackStatus: "paused",
          PlaybackElapsedTimeInMilliseconds: 42_500,
        },
      },
    });
    await service.stop();
  });

  test("stays forced on while Spotify is skipped", async () => {
    const host = new FakeHostBridge();
    const preferences = new MemoryPreferenceStore(false);
    const service = new SystemMediaService(host, new RecordingSink(), preferences);
    await service.start();
    expect(service.isActive).toBeFalse();
    expect(host.calls).toEqual([
      { method: "media.get_volume", params: {} },
      { method: "media.stop", params: {} },
    ]);

    await service.setForcedOn(true);
    expect(service.isForcedOn).toBeTrue();
    expect(service.isActive).toBeTrue();
    expect(service.isSystemMediaEnabled).toBeFalse();

    await service.setSystemMediaEnabled(false);
    expect(service.isActive).toBeTrue();
    await service.setForcedOn(false);
    expect(service.isActive).toBeFalse();
    expect(host.calls.at(-1)).toEqual({ method: "media.stop", params: {} });
    await service.stop();
  });

  test("maps every device media-control spelling onto the typed host action", async () => {
    const cases = [
      ["media.control.play", "play"],
      ["media.control.pause", "pause"],
      ["media.control.stop", "stop"],
      ["media.control.playPause", "toggle"],
      ["media.control.togglePlayPause", "toggle"],
      ["media.control.next", "next"],
      ["media.control.previous", "previous"],
      ["media.control.prev", "previous"],
      ["media.control.shuffle", "shuffle"],
      ["media.control.repeat", "repeat"],
      ["media.control.volumeUp", "volume_up"],
      ["media.control.volume_down", "volume_down"],
      ["media.control.like", "like"],
      ["media.control.unlike", "unlike"],
    ] as const;

    for (const [method, action] of cases) {
      expect(mediaControlAction(method)).toBe(action);
    }
    expect(mediaControlAction("media.control.seek")).toBeNull();

    const host = new FakeHostBridge();
    const service = new SystemMediaService(host, new RecordingSink());
    expect(await service.handleControl("media.control.play")).toBe("disabled");
    await service.start();
    expect(await service.handleControl("media.control.volumeUp")).toBe("ok");
    expect(host.calls.at(-1)).toEqual({
      method: "media.control",
      params: { action: "volume_up" },
    });
    await service.stop();
  });

  test("defaults isVolumeSupported to false before verification and updates on volume events or RPCs", async () => {
    class VolumeBridge extends FakeHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "media.get_volume") return { status: "unsupported" } as TResult;
        if (method === "volume.get") return { volume_percent: 50, muted: false } as TResult;
        return super.call(method, params);
      }
    }

    const host = new VolumeBridge();
    const service = new SystemMediaService(host, new RecordingSink());

    // Initially unknown before verification
    expect(service.isVolumeSupported).toBeFalse();

    await service.start();
    await service.whenIdle();
    // Failed probe -> still false
    expect(service.isVolumeSupported).toBeFalse();

    // Successful volume RPC -> recovers to true
    const res = await service.getVolume();
    expect(res).toEqual({ volume_percent: 50, muted: false });
    expect(service.isVolumeSupported).toBeTrue();

    await service.stop();
  });

  test("recovers isVolumeSupported to true when a valid device.volume.update event arrives", async () => {
    class UnsupportedVolumeBridge extends FakeHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "media.get_volume" || method === "volume.get") {
          return { status: "unsupported" } as TResult;
        }
        return super.call(method, params);
      }
    }

    const host = new UnsupportedVolumeBridge();
    const service = new SystemMediaService(host, new RecordingSink());
    await service.start();
    await service.whenIdle();

    expect(service.isVolumeSupported).toBeFalse();

    // Event arrives from host audio endpoint -> recovers to true!
    host.emit("device.volume.update", { volume_percent: 65, muted: false });
    expect(service.isVolumeSupported).toBeTrue();

    await service.stop();
  });

  test("rethrows unexpected host bridge errors in getVolume while marking volumeSupported false", async () => {
    class CrashingVolumeBridge extends FakeHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get") {
          throw new Error("Native pipe error");
        }
        return super.call(method, params);
      }
    }

    const host = new CrashingVolumeBridge();
    const service = new SystemMediaService(host, new RecordingSink());
    await service.start();

    await expect(service.getVolume()).rejects.toThrow("Native pipe error");
    expect(service.isVolumeSupported).toBeFalse();

    await service.stop();
  });
});

describe("normalizeNowPlayingUpdate", () => {
  test("accepts companion casing but emits the canonical wrapper", () => {
    expect(
      normalizeNowPlayingUpdate({
        MediaItemAttributes: {
          MediaItemTitle: "Song",
          MediaItemArtist: "Artist",
          ignored: "value",
        },
        PlaybackAttributes: {
          PlaybackStatus: "paused",
          PlaybackElapsedTimeInMilliseconds: 0,
          PlaybackRate: 1,
        },
        mediaGeneration: 4,
      }),
    ).toEqual({
      media_item_attributes: {
        MediaItemTitle: "Song",
        MediaItemArtist: "Artist",
      },
      playback_attributes: {
        PlaybackStatus: "paused",
        PlaybackElapsedTimeInMilliseconds: 0,
        PlaybackRate: 1,
      },
      media_generation: 4,
    });
  });
});
