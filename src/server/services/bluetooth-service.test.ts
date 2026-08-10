import { describe, expect, test } from "bun:test";
import { NocturneManager } from "../nocturne-manager";
import type { BluetoothDevice } from "../bluetooth/dbus-adapter";
import type { PairingPinEvent } from "../bluetooth/pairing-agent";
import type { RFCOMMConnection } from "../bluetooth/rfcomm-server";
import {
  BluetoothService,
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
  private disconnectHandler: ((address: string) => void) | null = null;
  private connectFailures: Error[] = [];

  setDataHandler(_handler: (data: Buffer) => void): void {}

  setDisconnectHandler(handler: (address: string) => void): void {
    this.disconnectHandler = handler;
  }

  async connect(address: string, channel?: number): Promise<void> {
    this.connectCalls.push({ address, channel });
    this.address = address;
    const failure = this.connectFailures.shift();
    if (failure) {
      this.connected = false;
      throw failure;
    }
    this.connected = true;
  }

  async write(_data: Buffer | Uint8Array): Promise<void> {}

  failNextConnects(count: number): void {
    for (let index = 0; index < count; index++) {
      this.connectFailures.push(new Error("connect failed"));
    }
  }

  triggerUnexpectedDisconnect(): void {
    this.connected = false;
    this.disconnectHandler?.(this.address);
  }
}

class FakeAdapter implements BluetoothAdapterLike {
  readonly removedAddresses: string[] = [];

  async initialize(): Promise<void> {}
  async powerOn(): Promise<void> {}
  async powerOff(): Promise<void> {}
  async setDiscoverable(_enabled: boolean): Promise<void> {}
  async setPairable(_enabled: boolean): Promise<void> {}
  async startDiscovery(): Promise<void> {}
  async stopDiscovery(): Promise<void> {}
  async pairDevice(_address: string): Promise<void> {}
  async trustDevice(_address: string): Promise<void> {}

  async removeDevice(address: string): Promise<void> {
    this.removedAddresses.push(address);
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    return [];
  }

  async getAdapterStatus(): Promise<{
    powered: boolean;
    discovering: boolean;
    address: string;
  }> {
    return { powered: true, discovering: false, address: "00:00:00:00:00:00" };
  }

  setOnPairComplete(_handler: (address: string) => void): void {}
  setOnDeviceConnected(_handler: (address: string) => void): void {}

  setOnDeviceFound(_handler: (device: BluetoothDevice) => void): void {}
  setOnDeviceUpdated(_handler: (device: BluetoothDevice) => void): void {}
}

class FakeRFCOMMServer implements RFCOMMServerLike {
  private connections = new Map<string, RFCOMMConnection>();

  setConnectionHandler(_handler: (conn: RFCOMMConnection) => void): void {}
  setDisconnectionHandler(_handler: (devicePath: string) => void): void {}
  setDataHandler(_handler: (devicePath: string, data: Buffer) => void): void {}
  async register(): Promise<void> {}
  async writeToDevice(_devicePath: string, _data: Buffer): Promise<void> {}

  getConnections(): Map<string, RFCOMMConnection> {
    return this.connections;
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
  reconnectDelaysMs: readonly number[] = [1_000, 2_000, 4_000]
) {
  const adapter = new FakeAdapter();
  const client = new FakeRFCOMMClient();
  const timers = new FakeTimers();
  const service = new BluetoothService({
    adapter,
    rfcommClient: client,
    rfcommServer: new FakeRFCOMMServer(),
    pairingAgent: new FakePairingAgent(),
    timers,
    reconnectDelaysMs,
  });
  return { adapter, client, service, timers };
}

describe("BluetoothService outbound reconnect", () => {
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
