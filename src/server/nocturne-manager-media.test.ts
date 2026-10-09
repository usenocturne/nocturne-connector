import { describe, expect, spyOn, test } from "bun:test";
import { HostBridge, frame, type HostBridgeClient } from "./platform/host-bridge";
import { decode } from "@msgpack/msgpack";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NocturneManager } from "./nocturne-manager";
import {
  BluetoothService,
  type BluetoothAdapterLike,
  type PairingAgentLike,
  type RFCOMMClientLike,
  type RFCOMMServerLike,
} from "./services/bluetooth-service";
import type { SpotifySkipPreferenceStore } from "./services/spotify-service";
import type { SystemMediaPreferenceStore } from "./services/system-media-service";

class MemoryBooleanPreference
  implements SpotifySkipPreferenceStore, SystemMediaPreferenceStore {
  constructor(private value: boolean) {}
  load(): boolean { return this.value; }
  save(value: boolean): void { this.value = value; }
}

class FakeMediaHostBridge implements HostBridgeClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  async call<TResult = unknown>(
    method: string,
    params: unknown = {},
  ): Promise<TResult> {
    this.calls.push({ method, params });
    const result: unknown = method === "media.control"
      ? { status: "ok" }
      : method === "media.get_volume"
        ? { volume_percent: null }
        : {};
    return result as TResult;
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

function fakeBluetoothService(): BluetoothService {
  const adapter: BluetoothAdapterLike = {
    async initialize() {},
    async powerOn() {},
    async powerOff() {},
    async setDiscoverable() {},
    async setPairable() {},
    async startDiscovery() {},
    async stopDiscovery() {},
    async getDevices() { return []; },
    async pairDevice() {},
    async trustDevice() {},
    async removeDevice() {},
    async getAdapterStatus() {
      return { powered: true, discovering: false, address: "00:00:00:00:00:00" };
    },
    setOnPairComplete() {},
    setOnDeviceConnected() {},
    setOnDeviceFound() {},
    setOnDeviceUpdated() {},
  };
  const rfcommServer: RFCOMMServerLike = {
    setConnectionHandler() {},
    setDisconnectionHandler() {},
    setDataHandler() {},
    async register() {},
    async writeToDevice() {},
    getConnections() { return new Map(); },
  };
  const rfcommClient: RFCOMMClientLike = {
    connected: false,
    address: "",
    setDataHandler() {},
    setDisconnectHandler() {},
    async connect() {},
    async write() {},
    disconnect() {},
  };
  const pairingAgent: PairingAgentLike = {
    pendingPin: null,
    setOnPinDisplay() {},
    setOnPairingCancelled() {},
    async register() {},
    confirmPairing() {},
    rejectPairing() {},
  };
  return new BluetoothService({
    adapter,
    rfcommServer,
    rfcommClient,
    pairingAgent,
  });
}

function hostPipePath(directory: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\connector-volume-${process.pid}-${crypto.randomUUID()}`
    : join(directory, "host.sock");
}

describe("NocturneManager system media routing", () => {
  test("a stalled volume probe reuses the established host connection without delaying Bluetooth", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-volume-"));
    const path = hostPipePath(directory);
    const peers = new Set<Socket>();
    let probePeer: Socket | undefined;
    let connectionCount = 0;
    const server = createServer((socket) => {
      connectionCount++;
      peers.add(socket);
      socket.on("close", () => peers.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, Buffer.from(data)]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (buffer.length < 4 + length) return;
          const request = decode(buffer.subarray(4, 4 + length)) as {
            id: number; generation: number; method: string;
          };
          buffer = buffer.subarray(4 + length);
          if (request.method === "media.get_volume") {
            probePeer = socket; // Native volume endpoint never responds.
          } else {
            socket.write(frame({ type: "response", id: request.id,
              generation: request.generation, result: {} }));
          }
        }
      });
    });
    const hostBridge = new HostBridge(path, "test-token");
    const bluetoothService = fakeBluetoothService();
    let bluetoothInitialized = false;
    const initializeBluetooth = bluetoothService.initialize.bind(bluetoothService);
    bluetoothService.initialize = async () => {
      bluetoothInitialized = true;
      await initializeBluetooth();
    };
    const manager = new NocturneManager({
      platform: "win32", hostBridge, bluetoothService,
      spotifySkipPreferenceStore: new MemoryBooleanPreference(false),
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      await hostBridge.call("bluetooth.initialize");
      const establishedPeer = [...peers][0];
      await manager.initializeOffline();
      expect(bluetoothInitialized).toBeTrue();
      expect(probePeer).toBe(establishedPeer);
      expect(manager.getCapabilities()).toMatchObject({ volume: false, media: true });
      // A round trip synchronizes all preceding requests without a fixed sleep.
      await hostBridge.call("bluetooth.get_status");
      expect(connectionCount).toBe(1);
      expect(establishedPeer?.destroyed).toBeFalse();
      await manager.systemMediaService?.stop();
    } finally {
      hostBridge.close();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an unavailable native host leaves capabilities false and Bluetooth initialized", async () => {
    const directory = mkdtempSync(join(tmpdir(), "connector-volume-"));
    const hostBridge = new HostBridge(hostPipePath(directory), "test-token");
    const bluetoothService = fakeBluetoothService();
    let bluetoothInitialized = false;
    bluetoothService.initialize = async () => { bluetoothInitialized = true; };
    const manager = new NocturneManager({
      platform: "win32", hostBridge, bluetoothService,
      spotifySkipPreferenceStore: new MemoryBooleanPreference(false),
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    try {
      await manager.initializeOffline();
      expect(bluetoothInitialized).toBeTrue();
      expect(manager.getCapabilities()).toMatchObject({ volume: false, media: false });
      await manager.systemMediaService?.stop();
    } finally {
      hostBridge.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("forces stored-disabled system media on when Spotify was skipped", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      spotifySkipPreferenceStore: new MemoryBooleanPreference(true),
      systemMediaPreferenceStore: new MemoryBooleanPreference(false),
    });

    await manager.initializeOffline();

    expect(manager.spotifyService.authState).toEqual({ status: "skipped" });
    expect(manager.systemMediaService?.isSystemMediaEnabled).toBeFalse();
    expect(manager.systemMediaService?.isForcedOn).toBeTrue();
    expect(manager.systemMediaService?.isActive).toBeTrue();
    expect(hostBridge.calls).toContainEqual({ method: "media.start", params: {} });
    await manager.systemMediaService?.stop();
  });

  test("routes volume RPC methods to SystemMediaService", async () => {
    class FakeVolumeManagerBridge extends FakeMediaHostBridge {
      vol = 50;
      muted = false;

      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "volume.get" || method === "media.get_volume") {
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

    const hostBridge = new FakeVolumeManagerBridge();
    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");
    await manager.systemMediaService.start();

    // volume.get
    await expect(
      manager.onCall("request", "volume.get", {}),
    ).resolves.toEqual({ result: { volume_percent: 50, muted: false } });

    // volume.set
    await expect(
      manager.onCall("request", "volume.set", { volume_percent: 75 }),
    ).resolves.toEqual({ result: { status: "ok", volume_percent: 75, muted: false } });

    // volume.adjust
    await expect(
      manager.onCall("request", "volume.adjust", { delta: -10 }),
    ).resolves.toEqual({ result: { status: "ok", volume_percent: 65, muted: false } });

    // volume.toggleMute
    await expect(
      manager.onCall("request", "volume.toggleMute", {}),
    ).resolves.toEqual({ result: { status: "ok", volume_percent: 65, muted: true } });

    // Verify params passed to hostBridge for unargumented toggleMute did NOT contain muted: undefined
    expect(hostBridge.calls.at(-1)).toEqual({
      method: "volume.toggleMute",
      params: {},
    });

    await manager.systemMediaService.stop();
  });

  test("forwards mute-only state changes with same volume percentage to NocturneManager sink and Car Thing RPC", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const fakeRpcClient = {
      call: (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        return Promise.resolve({ result: "ok" });
      },
    } as any;

    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");

    (manager as any).connections.set("fake-device", {
      rpcClient: fakeRpcClient,
      deviceInfo: null,
    });

    await manager.systemMediaService.start();

    // Initial volume 50, unmuted
    hostBridge.emit("device.volume.update", { volume_percent: 50, muted: false });
    await (manager as any).hostVolumeReportTask;
    expect(rpcCalls.at(-1)).toEqual({
      method: "device.volume.update",
      params: { volume_percent: 50, muted: false },
    });

    // Mute-only change: same volume 50, muted true
    hostBridge.emit("device.volume.update", { volume_percent: 50, muted: true });
    await (manager as any).hostVolumeReportTask;
    expect(rpcCalls.at(-1)).toEqual({
      method: "device.volume.update",
      params: { volume_percent: 50, muted: true },
    });

    // Legacy volume-only change (without muted) remains compatible
    hostBridge.emit("device.volume.update", { volume_percent: 60 });
    await (manager as any).hostVolumeReportTask;
    expect(rpcCalls.at(-1)).toEqual({
      method: "device.volume.update",
      params: { volume_percent: 60 },
    });

    await manager.systemMediaService.stop();
  });

  test("broadcasts native host media updates and artwork to connected Car Thing RPC clients with canonical payloads", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const eventsSent: Array<{ topic: string; data: unknown }> = [];
    const fakeRpcClient = {
      call: () => Promise.resolve({ result: "ok" }),
      sendEvent: (topic: string, data: unknown) => {
        eventsSent.push({ topic, data });
        return Promise.resolve();
      },
    } as any;

    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");

    (manager as any).connections.set("fake-device", {
      rpcClient: fakeRpcClient,
      deviceInfo: null,
    });

    await manager.systemMediaService.start();

    // Emit media update from native host
    hostBridge.emit("media.now_playing.update", {
      MediaItemAttributes: {
        MediaItemTitle: "Synergy",
        MediaItemArtist: "M83",
        MediaItemAlbumName: "Fantasy",
      },
      PlaybackAttributes: {
        PlaybackStatus: "playing",
        PlaybackAppName: "Edge",
        PlaybackElapsedTimeInMilliseconds: 30000,
        PlaybackRate: 1,
      },
      mediaGeneration: 1,
    });

    // Emit artwork from native host
    hostBridge.emit("media.now_playing.artwork", {
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      content_type: "image/jpeg",
      media_generation: 1,
    });

    await manager.systemMediaService.whenIdle();

    expect(eventsSent).toEqual([
      {
        topic: "media.now_playing.update",
        data: {
          media_item_attributes: {
            MediaItemTitle: "Synergy",
            MediaItemArtist: "M83",
            MediaItemAlbumName: "Fantasy",
          },
          playback_attributes: {
            PlaybackStatus: "playing",
            PlaybackAppName: "Edge",
            PlaybackElapsedTimeInMilliseconds: 30000,
            PlaybackRate: 1,
          },
          media_generation: 1,
        },
      },
      {
        topic: "media.now_playing.artwork",
        data: {
          data: "/9j/2Q==",
          content_type: "image/jpeg",
          media_generation: 1,
        },
      },
    ]);

    await manager.systemMediaService.stop();
  });

  test("maps device media control RPC calls to expected host-bridge actions", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");
    await manager.systemMediaService.start();

    const controls = [
      ["media.control.play", "play"],
      ["media.control.pause", "pause"],
      ["media.control.next", "next"],
      ["media.control.previous", "previous"],
      ["media.control.toggle", "toggle"],
      ["media.control.volumeUp", "volume_up"],
      ["media.control.volumeDown", "volume_down"],
    ] as const;

    for (const [method, action] of controls) {
      const res = await manager.onCall("request", method, {});
      expect(res).toEqual({ result: { status: "ok" } });
      expect(hostBridge.calls.at(-1)).toEqual({
        method: "media.control",
        params: { action },
      });
    }

    await manager.systemMediaService.stop();
  });

  test("filters Spotify-linked playback while allowing skipped or unlinked Spotify system media", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const eventsSent: Array<{ topic: string; data: unknown }> = [];
    const fakeRpcClient = {
      call: () => Promise.resolve({ result: "ok" }),
      sendEvent: (topic: string, data: unknown) => {
        eventsSent.push({ topic, data });
        return Promise.resolve();
      },
    } as any;

    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");
    (manager as any).connections.set("fake-device", {
      rpcClient: fakeRpcClient,
      deviceInfo: null,
    });

    await manager.systemMediaService.start();

    const spotifyUpdate = {
      media_item_attributes: { MediaItemTitle: "Spotify Song", MediaItemArtist: "Artist" },
      playback_attributes: { PlaybackStatus: "playing", PlaybackAppName: "Spotify" },
      media_generation: 1,
    };

    // Case 1: Unlinked Spotify -> Delivered
    hostBridge.emit("media.now_playing.update", spotifyUpdate);
    await manager.systemMediaService.whenIdle();
    expect(eventsSent).toHaveLength(1);
    expect(eventsSent[0].topic).toBe("media.now_playing.update");

    // Case 2: Linked Spotify -> Filtered / Suppressed
    eventsSent.length = 0;
    await manager.systemMediaService.setSpotifyLinked(true);
    hostBridge.emit("media.now_playing.update", spotifyUpdate);
    await manager.systemMediaService.whenIdle();
    expect(eventsSent).toHaveLength(0);

    // Case 3: Skipped Spotify (unlinked + skipped) -> Delivered
    await manager.systemMediaService.setSpotifyLinked(false);
    hostBridge.emit("media.now_playing.update", spotifyUpdate);
    await manager.systemMediaService.whenIdle();
    expect(eventsSent).toHaveLength(1);

    await manager.systemMediaService.stop();
  });

  test("replays media metadata and artwork with rebased timeline progress on device reconnect", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const eventsSent: Array<{ topic: string; data: unknown }> = [];
    const fakeRpcClient = {
      call: (method: string) => {
        if (method === "ping") return Promise.resolve({ pong: "pong" });
        if (method === "device.info") return Promise.resolve({ device: "Car Thing", version: "1.0" });
        return Promise.resolve({ result: "ok" });
      },
      sendEvent: (topic: string, data: unknown) => {
        eventsSent.push({ topic, data });
        return Promise.resolve();
      },
    } as any;

    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    const systemMedia = manager.systemMediaService;
    if (!systemMedia) throw new Error("expected system media service");

    await systemMedia.start();

    let nowMs = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      // Emit initial now playing update and artwork
      hostBridge.emit("media.now_playing.update", {
        media_item_attributes: {
          MediaItemTitle: "Replay Test",
          MediaItemArtist: "Artist",
          MediaItemPlaybackDurationInMilliseconds: 300000,
        },
        playback_attributes: {
          PlaybackStatus: "playing",
          PlaybackElapsedTimeInMilliseconds: 10000,
          PlaybackRate: 1,
        },
        media_generation: 5,
      });
      hostBridge.emit("media.now_playing.artwork", {
        data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        content_type: "image/jpeg",
        media_generation: 5,
      });
      await systemMedia.whenIdle();
      eventsSent.length = 0;

      nowMs += 5000;

      // Register connected device and trigger sendAppReady
      (manager as any).connections.set("fake-device", {
        rpcClient: fakeRpcClient,
        deviceInfo: null,
      });
      await (manager as any).sendAppReady();
    } finally {
      clock.mockRestore();
    }

    // Verify reconnected client received rebased track progress and artwork
    const replayedUpdate = eventsSent.find((e) => e.topic === "media.now_playing.update");
    const replayedArtwork = eventsSent.find((e) => e.topic === "media.now_playing.artwork");

    expect(replayedUpdate).toBeDefined();
    expect(
      (replayedUpdate?.data as any).playback_attributes.PlaybackElapsedTimeInMilliseconds,
    ).toBe(15000);

    expect(replayedArtwork).toBeDefined();
    expect((replayedArtwork?.data as any).media_generation).toBe(5);

    await systemMedia.stop();
  });

  test("handles media control gracefully when host indicates unsupported / no media session", async () => {
    class NoSessionHostBridge extends FakeMediaHostBridge {
      async call<TResult = unknown>(method: string, params: unknown = {}): Promise<TResult> {
        this.calls.push({ method, params });
        if (method === "media.control") {
          const action = (params as any)?.action;
          if (action === "volume_up" || action === "volume_down") {
            return { status: "ok" } as TResult;
          }
          return { status: "unsupported" } as TResult;
        }
        return super.call(method, params);
      }
    }

    const hostBridge = new NoSessionHostBridge();
    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
      systemMediaPreferenceStore: new MemoryBooleanPreference(true),
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");
    await manager.systemMediaService.start();

    // Transport controls return unsupported when no session is active
    await expect(
      manager.onCall("request", "media.control.play", {}),
    ).resolves.toEqual({ result: { status: "unsupported" } });

    // Master volume control still succeeds
    await expect(
      manager.onCall("request", "media.control.volumeUp", {}),
    ).resolves.toEqual({ result: { status: "ok" } });

    await manager.systemMediaService.stop();
  });

  test("preserves the Pi connector's unknown-method behavior without a host", async () => {
    const manager = new NocturneManager({
      platform: "linux",
      bluetoothService: fakeBluetoothService(),
    });

    await expect(
      manager.onCall("request", "media.control.previous", {}),
    ).resolves.toEqual({ error: "Unknown method: media.control.previous" });
  });
});
