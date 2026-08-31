import { describe, expect, test } from "bun:test";
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
    | { kind: "volume"; volumePercent: number }
  > = [];

  async sendEvent(topic: string, data: unknown): Promise<void> {
    this.deliveries.push({ kind: "event", topic, data });
  }

  async sendVolume(volumePercent: number): Promise<void> {
    this.deliveries.push({ kind: "volume", volumePercent });
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
  test("starts the host after registering listeners and reports initial volume", async () => {
    const host = new FakeHostBridge();
    const sink = new RecordingSink();
    host.volumePercent = 37;
    const service = new SystemMediaService(host, sink);

    await service.start();
    await service.whenIdle();

    expect(host.calls).toEqual([
      { method: "media.set_spotify_linked", params: { linked: false } },
      { method: "media.start", params: {} },
      { method: "media.get_volume", params: {} },
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
    expect(host.calls.slice(-3)).toEqual([
      { method: "media.set_spotify_linked", params: { linked: false } },
      { method: "media.start", params: {} },
      { method: "media.get_volume", params: {} },
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
    expect(host.calls).toEqual([{ method: "media.stop", params: {} }]);

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
