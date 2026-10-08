import { describe, expect, test } from "bun:test";
import type { HostBridgeClient } from "./platform/host-bridge";
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

describe("NocturneManager system media routing", () => {
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

    await manager.systemMediaService.stop();
  });

  test("forwards device media controls to the optional native host", async () => {
    const hostBridge = new FakeMediaHostBridge();
    const manager = new NocturneManager({
      platform: "win32",
      bluetoothService: fakeBluetoothService(),
      hostBridge,
    });
    if (!manager.systemMediaService) throw new Error("expected system media service");
    await manager.systemMediaService.start();

    await expect(
      manager.onCall("request", "media.control.previous", {}),
    ).resolves.toEqual({ result: { status: "ok" } });
    expect(hostBridge.calls.at(-1)).toEqual({
      method: "media.control",
      params: { action: "previous" },
    });

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
