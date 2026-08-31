import { describe, expect, test } from "bun:test";
import { NocturneManager } from "../nocturne-manager";
import type { BluetoothDevice } from "../bluetooth/dbus-adapter";
import type { PairingPinEvent } from "../bluetooth/pairing-agent";
import type { RFCOMMConnection } from "../bluetooth/rfcomm-server";
import {
  BluetoothService,
  bluetoothDisplayName,
  type BluetoothAdapterLike,
  type BluetoothTimerHandle,
  type BluetoothTimerScheduler,
  type PairingAgentLike,
  type RFCOMMClientLike,
  type RFCOMMServerLike,
} from "./bluetooth-service";

const DEVICE_ADDRESS = "30:E3:D6:00:B5:5F";

class FakeTimerHandle implements BluetoothTimerHandle {
  cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }
}

class FakeTimers implements BluetoothTimerScheduler {
  readonly scheduledDelays: number[] = [];
  private tasks: Array<{
    callback: () => void | Promise<void>;
    handle: FakeTimerHandle;
  }> = [];

  setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number
  ): BluetoothTimerHandle {
    const handle = new FakeTimerHandle();
    this.scheduledDelays.push(delayMs);
    this.tasks.push({ callback, handle });
    return handle;
  }

  clearTimeout(handle: BluetoothTimerHandle): void {
    handle.cancel();
  }

  get pendingCount(): number {
    return this.tasks.filter(({ handle }) => !handle.cancelled).length;
  }

  async runNext(): Promise<void> {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (!task || task.handle.cancelled) continue;
      await task.callback();
      return;
    }
    throw new Error("No pending timer");
  }
}

class FakeRFCOMMClient implements RFCOMMClientLike {
  connected = false;
  address = "";
  readonly connectCalls: Array<{ address: string; channel?: number }> = [];
  disconnectCalls = 0;
  private disconnectHandler: ((address: string) => void) | null = null;
  private connectFailures: Error[] = [];
  private deferredConnect: {
    started: () => void;
    gate: Promise<void>;
  } | null = null;

  setDataHandler(_handler: (data: Buffer) => void): void {}

  setDisconnectHandler(handler: (address: string) => void): void {
    this.disconnectHandler = handler;
  }

  async connect(address: string, channel?: number): Promise<void> {
    this.connectCalls.push({ address, channel });
    this.address = address;
    const deferred = this.deferredConnect;
    if (deferred) {
      this.deferredConnect = null;
      deferred.started();
      await deferred.gate;
    }
    const failure = this.connectFailures.shift();
    if (failure) {
      this.connected = false;
      throw failure;
    }
    this.connected = true;
  }

  async write(_data: Buffer | Uint8Array): Promise<void> {}

  disconnect(): void {
    this.disconnectCalls++;
    this.connected = false;
  }

  failNextConnects(count: number): void {
    for (let index = 0; index < count; index++) {
      this.connectFailures.push(new Error("connect failed"));
    }
  }

  triggerUnexpectedDisconnect(): void {
    this.connected = false;
    this.disconnectHandler?.(this.address);
  }

  deferNextConnection(): { started: Promise<void>; release: () => void } {
    let markStarted = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.deferredConnect = { started: markStarted, gate };
    return { started, release };
  }
}

class FakeAdapter implements BluetoothAdapterLike {
  readonly removedAddresses: string[] = [];
  devices: BluetoothDevice[] = [];
  startDiscoveryCalls = 0;
  stopDiscoveryCalls = 0;
  private deviceConnectedHandler: ((address: string) => void) | null = null;

  async initialize(): Promise<void> {}
  async powerOn(): Promise<void> {}
  async powerOff(): Promise<void> {}
  async setDiscoverable(_enabled: boolean): Promise<void> {}
  async setPairable(_enabled: boolean): Promise<void> {}
  async startDiscovery(): Promise<void> { this.startDiscoveryCalls++; }
  async stopDiscovery(): Promise<void> { this.stopDiscoveryCalls++; }
  async pairDevice(_address: string): Promise<void> {}
  async trustDevice(_address: string): Promise<void> {}

  async removeDevice(address: string): Promise<void> {
    this.removedAddresses.push(address);
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    return this.devices;
  }

  async getAdapterStatus(): Promise<{
    powered: boolean;
    discovering: boolean;
    address: string;
  }> {
    return { powered: true, discovering: false, address: "00:00:00:00:00:00" };
  }

  setOnPairComplete(_handler: (address: string) => void): void {}
  setOnDeviceConnected(handler: (address: string) => void): void {
    this.deviceConnectedHandler = handler;
  }

  setOnDeviceFound(_handler: (device: BluetoothDevice) => void): void {}
  setOnDeviceUpdated(_handler: (device: BluetoothDevice) => void): void {}

  triggerDeviceConnected(address: string): void {
    this.deviceConnectedHandler?.(address);
  }
}

class FakeRFCOMMServer implements RFCOMMServerLike {
  private connections = new Map<string, RFCOMMConnection>();
  private disconnectionHandler: ((devicePath: string) => void) | null = null;
  disconnectCalls = 0;

  setConnectionHandler(_handler: (conn: RFCOMMConnection) => void): void {}
  setDisconnectionHandler(handler: (devicePath: string) => void): void {
    this.disconnectionHandler = handler;
  }
  setDataHandler(_handler: (devicePath: string, data: Buffer) => void): void {}
  async register(): Promise<void> {}
  async writeToDevice(_devicePath: string, _data: Buffer): Promise<void> {}

  getConnections(): Map<string, RFCOMMConnection> {
    return this.connections;
  }

  disconnectDevice(address: string): boolean {
    const matches = Array.from(this.connections.entries()).filter(
      ([, connection]) => connection.address === address,
    );
    for (const [devicePath] of matches) {
      this.connections.delete(devicePath);
      this.disconnectCalls++;
      this.disconnectionHandler?.(devicePath);
    }
    return matches.length > 0;
  }

  addConnection(devicePath: string, address: string): void {
    this.connections.set(devicePath, { devicePath, address, fd: -1, stream: null });
  }
}

class FakePairingAgent implements PairingAgentLike {
  pendingPin: PairingPinEvent | null = null;

  setOnPinDisplay(_handler: (event: PairingPinEvent) => void): void {}
  setOnPairingCancelled(_handler: () => void): void {}
  async register(): Promise<void> {}
  confirmPairing(): void {}
  rejectPairing(): void {}
}

function makeHarness(
  reconnectDelaysMs: readonly number[] = [1_000, 2_000, 4_000],
  platform: NodeJS.Platform = "win32",
) {
  const adapter = new FakeAdapter();
  const client = new FakeRFCOMMClient();
  const server = new FakeRFCOMMServer();
  const timers = new FakeTimers();
  const service = new BluetoothService({
    platform,
    adapter,
    rfcommClient: client,
    rfcommServer: server,
    pairingAgent: new FakePairingAgent(),
    timers,
    reconnectDelaysMs,
  });
  return { adapter, client, server, service, timers };
}

describe("BluetoothService Pi parity", () => {
  test("keeps scan lifetime client-owned and preserves BlueZ device state", async () => {
    const { adapter, server, service, timers } = makeHarness(
      [1_000, 2_000, 4_000],
      "linux",
    );
    adapter.devices = [{
      address: DEVICE_ADDRESS,
      name: `Bluetooth ${DEVICE_ADDRESS}`,
      paired: true,
      connected: true,
      trusted: true,
      rssi: -42,
      icon: "computer",
    }];
    server.addConnection("rfcomm-server:one", DEVICE_ADDRESS);
    await service.initialize();
    await service.startScan();

    expect(timers.pendingCount).toBe(0);
    expect(await service.getDevices()).toEqual(adapter.devices);
    expect(service.getConnections().has("rfcomm-server:one")).toBeTrue();
  });

  test("keeps manual disconnect and close-before-unpair disabled", async () => {
    const { adapter, client, server, service } = makeHarness(
      [1_000, 2_000, 4_000],
      "linux",
    );
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    server.addConnection("rfcomm-server:one", DEVICE_ADDRESS);

    await expect(service.disconnect(DEVICE_ADDRESS)).rejects.toThrow(
      "not supported",
    );
    await service.unpair(DEVICE_ADDRESS);

    expect(client.disconnectCalls).toBe(0);
    expect(server.disconnectCalls).toBe(0);
    expect(adapter.removedAddresses).toEqual([DEVICE_ADDRESS]);
  });

  test("does not enter Windows retry backoff after a post-pair connect failure", async () => {
    const { adapter, client, service, timers } = makeHarness(
      [1_000, 2_000, 4_000],
      "linux",
    );
    await service.initialize();
    client.failNextConnects(1);
    adapter.triggerDeviceConnected(DEVICE_ADDRESS);
    expect(timers.scheduledDelays).toEqual([2_000]);

    await timers.runNext();

    expect(client.connectCalls).toEqual([{ address: DEVICE_ADDRESS, channel: 2 }]);
    expect(timers.pendingCount).toBe(0);
  });
});

describe("BluetoothService outbound reconnect", () => {
  test("normalizes generated Windows Bluetooth names", () => {
    expect(bluetoothDisplayName("", DEVICE_ADDRESS)).toBe("Unknown Device");
    expect(bluetoothDisplayName(`Bluetooth ${DEVICE_ADDRESS.toLowerCase()}`, DEVICE_ADDRESS))
      .toBe("Unknown Device");
    expect(bluetoothDisplayName("Nocturne (Q01S)", DEVICE_ADDRESS))
      .toBe("Nocturne (Q01S)");
  });

  test("does not scan during initialization and stops a requested scan after 30 seconds", async () => {
    const { adapter, service, timers } = makeHarness();
    await service.initialize();
    expect(adapter.startDiscoveryCalls).toBe(0);

    await service.startScan();
    expect(adapter.startDiscoveryCalls).toBe(1);
    expect(timers.scheduledDelays.at(-1)).toBe(30_000);

    await timers.runNext();
    expect(adapter.stopDiscoveryCalls).toBe(1);
  });

  test("manual scan stop cancels the automatic timeout", async () => {
    const { adapter, service, timers } = makeHarness();
    await service.initialize();
    await service.startScan();
    expect(timers.pendingCount).toBe(1);

    await service.stopScan();

    expect(adapter.stopDiscoveryCalls).toBe(1);
    expect(timers.pendingCount).toBe(0);
  });

  test("emits disconnect before redialing the last outbound address", async () => {
    const { client, service, timers } = makeHarness();
    const events: string[] = [];
    service.onEvent((event) => events.push(event));
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    events.length = 0;

    client.triggerUnexpectedDisconnect();

    expect(events).toEqual(["deviceDisconnected"]);
    expect(timers.scheduledDelays).toEqual([1_000]);
    expect(client.connectCalls).toHaveLength(1);

    await timers.runNext();

    expect(client.connectCalls).toEqual([
      { address: DEVICE_ADDRESS, channel: 2 },
      { address: DEVICE_ADDRESS, channel: 2 },
    ]);
    expect(events).toEqual(["deviceDisconnected", "deviceConnected"]);
  });

  test("backs off to the configured maximum and resets after success", async () => {
    const { client, service, timers } = makeHarness([10, 20, 30]);
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    client.failNextConnects(3);
    client.triggerUnexpectedDisconnect();

    await timers.runNext();
    await timers.runNext();
    await timers.runNext();

    expect(timers.scheduledDelays).toEqual([10, 20, 30, 30]);

    await timers.runNext();
    expect(client.connected).toBeTrue();
    expect(timers.pendingCount).toBe(0);

    client.triggerUnexpectedDisconnect();
    expect(timers.scheduledDelays.at(-1)).toBe(10);
  });

  test("resets a stale outbound route before entering reconnect backoff", async () => {
    const { client, service, timers } = makeHarness();
    const events: string[] = [];
    service.onEvent((event) => events.push(event));
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    events.length = 0;

    await service.recoverOutboundConnection(DEVICE_ADDRESS);

    expect(client.disconnectCalls).toBe(1);
    expect(events).toEqual(["deviceDisconnected"]);
    expect(timers.scheduledDelays.at(-1)).toBe(1_000);
  });

  test("manual disconnect closes the route and updates route-backed device state", async () => {
    const { adapter, client, service, timers } = makeHarness();
    const events: string[] = [];
    adapter.devices = [{
      address: DEVICE_ADDRESS,
      name: "Nocturne (Q01S)",
      paired: true,
      connected: true,
      trusted: true,
      rssi: -42,
      icon: "computer",
    }];
    service.onEvent((event) => events.push(event));
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    expect((await service.getDevices())[0]?.connected).toBeTrue();
    expect(service.getConnections().has(`rfcomm-client:${DEVICE_ADDRESS}`)).toBeTrue();
    events.length = 0;

    await service.disconnect(DEVICE_ADDRESS);

    expect(client.disconnectCalls).toBe(1);
    expect(client.connected).toBeFalse();
    expect(events).toEqual(["deviceDisconnected"]);
    expect(timers.pendingCount).toBe(0);
    expect((await service.getDevices())[0]?.connected).toBeFalse();
    expect(service.getConnections().size).toBe(0);
  });

  test("manual disconnect closes outbound and every inbound route for the address", async () => {
    const { client, server, service } = makeHarness();
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    server.addConnection("rfcomm-server:one", DEVICE_ADDRESS);
    server.addConnection("rfcomm-server:two", DEVICE_ADDRESS);

    await service.disconnect(DEVICE_ADDRESS);

    expect(client.disconnectCalls).toBe(1);
    expect(server.disconnectCalls).toBe(2);
    expect(service.getConnections().size).toBe(0);
  });

  test("unpair closes an active route before removing the bond", async () => {
    const { adapter, client, service, timers } = makeHarness();
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);

    await service.unpair(DEVICE_ADDRESS);

    expect(client.disconnectCalls).toBe(1);
    expect(adapter.removedAddresses).toEqual([DEVICE_ADDRESS]);
    expect(timers.pendingCount).toBe(0);

    adapter.triggerDeviceConnected(DEVICE_ADDRESS);
    expect(timers.pendingCount).toBe(0);
  });

  test("unpair closes an automatic connection that completes after suppression", async () => {
    const { adapter, client, service, timers } = makeHarness();
    await service.initialize();
    const deferred = client.deferNextConnection();
    adapter.triggerDeviceConnected(DEVICE_ADDRESS);
    const attempt = timers.runNext();
    await deferred.started;

    await service.unpair(DEVICE_ADDRESS);
    deferred.release();
    await attempt;

    expect(client.connected).toBeFalse();
    expect(client.disconnectCalls).toBe(1);
    expect(adapter.removedAddresses).toEqual([DEVICE_ADDRESS]);
    expect(timers.pendingCount).toBe(0);
  });

  test("cancels pending redials on manual connect and unpair", async () => {
    const { adapter, client, service, timers } = makeHarness();
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    client.triggerUnexpectedDisconnect();
    expect(timers.pendingCount).toBe(1);

    await service.connect(DEVICE_ADDRESS, 2);
    expect(timers.pendingCount).toBe(0);

    client.triggerUnexpectedDisconnect();
    expect(timers.pendingCount).toBe(1);
    await service.unpair(DEVICE_ADDRESS);

    expect(timers.pendingCount).toBe(0);
    expect(adapter.removedAddresses).toEqual([DEVICE_ADDRESS]);
  });

  test("cancels pending redials when Bluetooth powers off", async () => {
    const { client, service, timers } = makeHarness();
    await service.initialize();
    await service.connect(DEVICE_ADDRESS, 2);
    client.triggerUnexpectedDisconnect();
    expect(timers.pendingCount).toBe(1);

    await service.powerOff();

    expect(timers.pendingCount).toBe(0);
  });

  test("removes the stale manager connection before scheduling redial", async () => {
    const { client, service, timers } = makeHarness();
    const manager = new NocturneManager({ bluetoothService: service });
    await manager.initializeOffline();
    await service.connect(DEVICE_ADDRESS, 2);
    expect(manager.getConnectionStatus().connected).toBeTrue();

    client.triggerUnexpectedDisconnect();

    expect(manager.getConnectionStatus()).toEqual({
      connected: false,
      deviceCount: 0,
      devices: [],
    });
    expect(timers.pendingCount).toBe(1);
  });
});
