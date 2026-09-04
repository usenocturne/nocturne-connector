import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NocturneManager } from "./nocturne-manager";
import { RPCClient, type RPCClientDelegate } from "./rpc/rpc-client";
import {
  BluetoothService,
  type BluetoothAdapterLike,
  type BluetoothTimerHandle,
  type BluetoothTimerScheduler,
  type PairingAgentLike,
  type RFCOMMClientLike,
  type RFCOMMServerLike,
} from "./services/bluetooth-service";
import { CarThingOTAService } from "./services/car-thing-ota-service";

const DEVICE_ADDRESS = "30:E3:D6:00:B5:5F";
const PRIMARY_BYTES = Buffer.from("signed swu fixture");
const RANGE_BYTES = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

class NoopTimer implements BluetoothTimerHandle {
  cancel(): void {}
}

class HeldTimers implements BluetoothTimerScheduler {
  setTimeout(): BluetoothTimerHandle {
    return new NoopTimer();
  }

  clearTimeout(handle: BluetoothTimerHandle): void {
    handle.cancel();
  }
}

class LoopbackDaemon implements RPCClientDelegate {
  readonly client = new RPCClient("test-daemon", "base64-newline", {
    preserveConnectionWireFormat: true,
  });
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly events: Array<{ topic: string; data: unknown }> = [];
  private connectorDataHandler: ((data: Buffer) => void) | null = null;

  constructor() {
    this.client.setDelegate(this);
    this.client.setSocket({
      write: async (data) => {
        this.connectorDataHandler?.(Buffer.from(data));
      },
      end() {},
    });
  }

  setConnectorDataHandler(handler: (data: Buffer) => void): void {
    this.connectorDataHandler = handler;
  }

  async receive(data: Buffer | Uint8Array): Promise<void> {
    await this.client.handleIncomingData(Buffer.from(data));
  }

  async onCall(
    _id: string,
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: string }> {
    this.calls.push({ method, params });
    if (method === "device.info") {
      return {
        result: {
          device: "Nocturne",
          version: "4.1.0",
          image_version: "4.1.0",
          bandaid_version: "4.1.0",
        },
      };
    }
    if (method === "ota.begin") {
      return { result: { resume_from_offset: 3 } };
    }
    return { result: {} };
  }

  onEvent(topic: string, data: unknown): void {
    this.events.push({ topic, data });
  }

  onError(): void {}
  onDisconnect(): void {}
}

class LoopbackRFCOMMClient implements RFCOMMClientLike {
  connected = false;
  address = "";
  private dataHandler: ((data: Buffer) => void) | null = null;
  private disconnectHandler: ((address: string) => void) | null = null;

  constructor(private readonly daemon: LoopbackDaemon) {}

  setDataHandler(handler: (data: Buffer) => void): void {
    this.dataHandler = handler;
    this.daemon.setConnectorDataHandler(handler);
  }

  setDisconnectHandler(handler: (address: string) => void): void {
    this.disconnectHandler = handler;
  }

  async connect(address: string): Promise<void> {
    this.address = address;
    this.connected = true;
  }

  async write(data: Buffer | Uint8Array): Promise<void> {
    await this.daemon.receive(data);
  }

  disconnect(): void {
    const address = this.address;
    this.connected = false;
    this.disconnectHandler?.(address);
  }
}

function fakeBluetoothService(daemon: LoopbackDaemon): {
  service: BluetoothService;
  client: LoopbackRFCOMMClient;
} {
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
      return {
        powered: true,
        discovering: false,
        address: "00:00:00:00:00:00",
      };
    },
    setOnPairComplete() {},
    setOnDeviceConnected() {},
    setOnDeviceFound() {},
    setOnDeviceUpdated() {},
  };
  const server: RFCOMMServerLike = {
    setConnectionHandler() {},
    setDisconnectionHandler() {},
    setDataHandler() {},
    async register() {},
    async writeToDevice() {},
    getConnections() { return new Map(); },
  };
  const pairingAgent: PairingAgentLike = {
    pendingPin: null,
    setOnPinDisplay() {},
    setOnPairingCancelled() {},
    async register() {},
    confirmPairing() {},
    rejectPairing() {},
  };
  const client = new LoopbackRFCOMMClient(daemon);
  return {
    client,
    service: new BluetoothService({
      platform: "linux",
      adapter,
      rfcommServer: server,
      rfcommClient: client,
      pairingAgent,
      timers: new HeldTimers(),
    }),
  };
}

describe("NocturneManager Car Thing OTA", () => {
  test("prefetches every asset before package-ready and resumes offline", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "nocturne-manager-ota-"));
    const daemon = new LoopbackDaemon();
    const bluetooth = fakeBluetoothService(daemon);
    let secondaryRequested = false;
    let releaseSecondary = () => {};
    const secondaryGate = new Promise<void>((resolve) => {
      releaseSecondary = resolve;
    });
    let secondaryRequests = 0;
    let rangeHeaderSeen = false;
    let server: ReturnType<typeof Bun.serve> | null = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const origin = url.origin;
        if (url.pathname === "/v2/manifest") {
          return Response.json({
            manifest_version: 2,
            channel: "stable",
            update_available: true,
            update: {
              update_id: "release-4.2.0",
              version: "4.2.0",
              kind: "image",
              expected_sha256: sha256(PRIMARY_BYTES),
              expected_size: PRIMARY_BYTES.length,
              update_url_base: `${origin}/v2/artifacts/release-4.2.0`,
              assets: [
                {
                  name: "nocturne.swu",
                  size: PRIMARY_BYTES.length,
                  sha256: sha256(PRIMARY_BYTES),
                },
                {
                  name: "system.img.zck",
                  size: RANGE_BYTES.length,
                  sha256: sha256(RANGE_BYTES),
                },
              ],
            },
          });
        }
        if (url.pathname.endsWith("/nocturne.swu")) {
          return new Response(PRIMARY_BYTES);
        }
        if (url.pathname.endsWith("/system.img.zck")) {
          secondaryRequests++;
          rangeHeaderSeen ||= request.headers.has("range");
          secondaryRequested = true;
          await secondaryGate;
          return new Response(RANGE_BYTES);
        }
        return new Response("not found", { status: 404 });
      },
    });

    const manager = new NocturneManager({
      bluetoothService: bluetooth.service,
      carThingOtaService: new CarThingOTAService({
        serverUrl: server.url.origin,
        stateDir,
      }),
    });

    try {
      await manager.initializeOffline();
      await bluetooth.service.connect(DEVICE_ADDRESS, 2);
      await waitFor(() => eventCount(daemon, "app.ready") === 1);

      await daemon.client.sendEvent("ota.request_install", {
        current_version: "4.1.0",
        image_version: "4.1.0",
        bandaid_version: "4.1.0",
        channel: "stable",
        target_version: "4.2.0",
        target_kind: "image",
      });
      await waitFor(() => secondaryRequested);
      expect(eventCount(daemon, "ota.package_ready")).toBe(0);
      expect(rangeHeaderSeen).toBe(false);

      bluetooth.client.disconnect();
      await bluetooth.service.connect(DEVICE_ADDRESS, 2);
      await waitFor(() => eventCount(daemon, "app.ready") === 2);

      releaseSecondary();
      await waitFor(() => eventCount(daemon, "ota.package_ready") === 1);
      expect(callCount(daemon, "ota.begin")).toBe(2);
      expect(secondaryRequests).toBe(1);

      server.stop(true);
      server = null;
      await daemon.client.sendEvent("ota.asset_range", {
        update_id: "release-4.2.0",
        request_id: "range-1",
        asset: "system.img.zck",
        ranges: [{ start: 5, length: 12 }],
      });
      await waitFor(() => callCount(daemon, "ota.asset_range_chunk") === 1);
      const rangeChunk = lastCallParams(daemon, "ota.asset_range_chunk");
      expect(Buffer.from(rangeChunk.bytes as Uint8Array)).toEqual(
        RANGE_BYTES.subarray(5, 17),
      );

      bluetooth.client.disconnect();
      await bluetooth.service.connect(DEVICE_ADDRESS, 2);
      await waitFor(() => eventCount(daemon, "ota.package_ready") === 2);
      expect(callCount(daemon, "ota.begin")).toBe(3);
      expect(secondaryRequests).toBe(1);
      expect(lastEventData(daemon, "ota.package_ready")).toMatchObject({
        updateId: "release-4.2.0",
        resumeFromOffset: 3,
      });
    } finally {
      server?.stop(true);
      bluetooth.client.disconnect();
      daemon.client.cleanup();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function eventCount(daemon: LoopbackDaemon, topic: string): number {
  return daemon.events.filter((event) => event.topic === topic).length;
}

function callCount(daemon: LoopbackDaemon, method: string): number {
  return daemon.calls.filter((call) => call.method === method).length;
}

function lastCallParams(
  daemon: LoopbackDaemon,
  method: string,
): Record<string, unknown> {
  const params = daemon.calls
    .slice()
    .reverse()
    .find((call) => call.method === method)?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Missing ${method} call parameters`);
  }
  return params as Record<string, unknown>;
}

function lastEventData(
  daemon: LoopbackDaemon,
  topic: string,
): Record<string, unknown> {
  const data = daemon.events
    .slice()
    .reverse()
    .find((event) => event.topic === topic)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Missing ${topic} event data`);
  }
  return data as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
}
