import { RFCOMM_UUID } from "../../config";
import type { BluetoothDevice } from "../../bluetooth/types";
import type { RFCOMMConnection } from "../../bluetooth/rfcomm-server";
import type { PairingPinEvent } from "../../bluetooth/pairing-agent";
import type {
  BluetoothAdapterLike,
  PairingAgentLike,
  RFCOMMClientLike,
  RFCOMMServerLike,
} from "../../services/bluetooth-service";
import { createLogger } from "../../utils/logger";
import type { HostBridgeClient } from "../host-bridge";

const log = createLogger("WindowsBluetooth");

interface HostBluetoothStatus {
  powered: boolean;
  discovering: boolean;
  address: string;
}

interface HostAddressEvent {
  address: string;
}

interface HostPairingEvent extends HostAddressEvent {
  name?: string;
  pin: string;
}

interface HostServerConnectionEvent extends HostAddressEvent {
  connectionId: string;
}

interface HostServerDataEvent {
  connectionId: string;
  data: Uint8Array;
}

interface HostClientDataEvent {
  data: Uint8Array;
}

export class WindowsBluetoothAdapter implements BluetoothAdapterLike {
  private onPairComplete: ((address: string) => void) | null = null;
  private onDeviceConnected: ((address: string) => void) | null = null;
  private onDeviceFound: ((device: BluetoothDevice) => void) | null = null;
  private onDeviceUpdated: ((device: BluetoothDevice) => void) | null = null;
  private onAdapterStatus: ((status: HostBluetoothStatus) => void) | null = null;
  private subscriptions: (() => void)[] = [];

  constructor(private readonly bridge: HostBridgeClient) {}

  async initialize(): Promise<void> {
    if (this.subscriptions.length === 0) {
      this.subscriptions.push(
        this.bridge.onEvent<BluetoothDevice>("bluetooth.device_found", (device) => {
          if (isBluetoothDevice(device)) this.onDeviceFound?.(device);
        }),
        this.bridge.onEvent<BluetoothDevice>("bluetooth.device_updated", (device) => {
          if (isBluetoothDevice(device)) this.onDeviceUpdated?.(device);
        }),
        this.bridge.onEvent<HostAddressEvent>("bluetooth.pair_complete", (event) => {
          if (validAddressEvent(event)) this.onPairComplete?.(event.address);
        }),
        this.bridge.onEvent<HostAddressEvent>("bluetooth.acl_connected", (event) => {
          if (validAddressEvent(event)) this.onDeviceConnected?.(event.address);
        }),
        this.bridge.onEvent<HostBluetoothStatus>("bluetooth.adapter_status", (status) => {
          if (isBluetoothStatus(status)) this.onAdapterStatus?.(status);
        }),
      );
    }
    await this.bridge.call("bluetooth.initialize");
  }

  async powerOn(): Promise<void> {
    await this.bridge.call("bluetooth.set_power", { powered: true });
  }

  async powerOff(): Promise<void> {
    await this.bridge.call("bluetooth.set_power", { powered: false });
  }

  async setDiscoverable(enabled: boolean): Promise<void> {
    await this.bridge.call("bluetooth.set_discoverable", { enabled });
  }

  async setPairable(enabled: boolean): Promise<void> {
    await this.bridge.call("bluetooth.set_pairable", { enabled });
  }

  async startDiscovery(): Promise<void> {
    await this.bridge.call("bluetooth.start_discovery");
  }

  async stopDiscovery(): Promise<void> {
    await this.bridge.call("bluetooth.stop_discovery");
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    const response = await this.bridge.call<unknown>("bluetooth.get_devices");
    const devices = Array.isArray(response)
      ? response
      : isRecord(response) && Array.isArray(response.devices)
        ? response.devices
        : [];
    return devices.filter(isBluetoothDevice);
  }

  async pairDevice(address: string): Promise<void> {
    await this.bridge.call(
      "bluetooth.pair",
      { address },
      { timeoutMs: 120_000 },
    );
  }

  async trustDevice(address: string): Promise<void> {
    await this.bridge.call("bluetooth.trust", { address });
  }

  async removeDevice(address: string): Promise<void> {
    await this.bridge.call("bluetooth.remove", { address });
  }

  async getAdapterStatus(): Promise<HostBluetoothStatus> {
    const response = await this.bridge.call<unknown>("bluetooth.get_status");
    const value = isRecord(response) ? response : {};
    return {
      powered: value.powered === true,
      discovering: value.discovering === true,
      address: typeof value.address === "string" ? value.address : "",
    };
  }

  setOnPairComplete(handler: (address: string) => void): void {
    this.onPairComplete = handler;
  }

  setOnDeviceConnected(handler: (address: string) => void): void {
    this.onDeviceConnected = handler;
  }

  setOnDeviceFound(handler: (device: BluetoothDevice) => void): void {
    this.onDeviceFound = handler;
  }

  setOnDeviceUpdated(handler: (device: BluetoothDevice) => void): void {
    this.onDeviceUpdated = handler;
  }

  setOnAdapterStatus(handler: (status: HostBluetoothStatus) => void): void {
    this.onAdapterStatus = handler;
  }
}

export class WindowsPairingAgent implements PairingAgentLike {
  private _pendingPin: PairingPinEvent | null = null;
  private onPinDisplay: ((event: PairingPinEvent) => void) | null = null;
  private onPairingCancelled: (() => void) | null = null;
  private subscriptions: (() => void)[] = [];

  constructor(private readonly bridge: HostBridgeClient) {}

  get pendingPin(): PairingPinEvent | null {
    return this._pendingPin;
  }

  setOnPinDisplay(handler: (event: PairingPinEvent) => void): void {
    this.onPinDisplay = handler;
  }

  setOnPairingCancelled(handler: () => void): void {
    this.onPairingCancelled = handler;
  }

  async register(): Promise<void> {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bridge.onEvent<HostPairingEvent>("bluetooth.pairing_request", (event) => {
        if (!validAddressEvent(event) || typeof event.pin !== "string") return;
        this._pendingPin = {
          address: event.address,
          name: event.name ?? "",
          pin: event.pin,
          type: "bluetooth_pin",
        };
        this.onPinDisplay?.(this._pendingPin);
      }),
      this.bridge.onEvent("bluetooth.pairing_cancelled", () => {
        this._pendingPin = null;
        this.onPairingCancelled?.();
      }),
    );
  }

  confirmPairing(): void {
    this._pendingPin = null;
    void this.bridge.call("bluetooth.pairing.confirm").catch((error) => {
      log.error(`Pairing confirmation failed: ${errorMessage(error)}`);
    });
  }

  rejectPairing(): void {
    this._pendingPin = null;
    void this.bridge.call("bluetooth.pairing.reject").catch((error) => {
      log.error(`Pairing rejection failed: ${errorMessage(error)}`);
    });
  }
}

export class WindowsRFCOMMServer implements RFCOMMServerLike {
  private onConnection: ((connection: RFCOMMConnection) => void) | null = null;
  private onDisconnection: ((devicePath: string) => void) | null = null;
  private onData: ((devicePath: string, data: Buffer) => void) | null = null;
  private connections = new Map<string, RFCOMMConnection>();
  private hostConnectionIds = new Map<string, string>();
  private subscriptions: (() => void)[] = [];

  constructor(private readonly bridge: HostBridgeClient) {}

  setConnectionHandler(handler: (connection: RFCOMMConnection) => void): void {
    this.onConnection = handler;
  }

  setDisconnectionHandler(handler: (devicePath: string) => void): void {
    this.onDisconnection = handler;
  }

  setDataHandler(handler: (devicePath: string, data: Buffer) => void): void {
    this.onData = handler;
  }

  async register(): Promise<void> {
    if (this.subscriptions.length === 0) {
      this.subscriptions.push(
        this.bridge.onEvent<HostServerConnectionEvent>("rfcomm.server.connected", (event) => {
          if (!validServerConnectionEvent(event)) return;
          const devicePath = `rfcomm-server:${event.connectionId}`;
          const connection: RFCOMMConnection = {
            devicePath,
            address: event.address,
            fd: -1,
            stream: null,
          };
          this.connections.set(devicePath, connection);
          this.hostConnectionIds.set(devicePath, event.connectionId);
          this.onConnection?.(connection);
        }),
        this.bridge.onEvent<HostServerConnectionEvent>("rfcomm.server.disconnected", (event) => {
          if (typeof event?.connectionId !== "string") return;
          const devicePath = `rfcomm-server:${event.connectionId}`;
          if (!this.connections.delete(devicePath)) return;
          this.hostConnectionIds.delete(devicePath);
          this.onDisconnection?.(devicePath);
        }),
        this.bridge.onEvent<HostServerDataEvent>("rfcomm.server.data", (event) => {
          if (typeof event?.connectionId !== "string" || !isBytes(event.data)) return;
          const devicePath = `rfcomm-server:${event.connectionId}`;
          if (!this.connections.has(devicePath)) return;
          this.onData?.(devicePath, Buffer.from(event.data));
        }),
      );
    }
    await this.bridge.call("rfcomm.server.register", {
      serviceUuid: RFCOMM_UUID,
      channel: 1,
      probeChannel: 3,
    });
  }

  async writeToDevice(devicePath: string, data: Buffer): Promise<void> {
    const connectionId = this.hostConnectionIds.get(devicePath);
    if (!connectionId || !this.connections.has(devicePath)) {
      throw new Error(`No connection for ${devicePath}`);
    }
    await this.bridge.call("rfcomm.server.write", {
      connectionId,
      data: Array.from(data),
    });
  }

  getConnections(): Map<string, RFCOMMConnection> {
    return this.connections;
  }

  async disconnectDevice(address: string): Promise<boolean> {
    const normalized = address.toUpperCase();
    const matches = Array.from(this.connections.entries()).filter(
      ([, connection]) => connection.address.toUpperCase() === normalized,
    );
    let disconnected = false;
    for (const [devicePath] of matches) {
      const connectionId = this.hostConnectionIds.get(devicePath);
      if (!connectionId) continue;
      await this.bridge.call("rfcomm.server.disconnect", { connectionId });
      if (this.connections.delete(devicePath)) {
        this.hostConnectionIds.delete(devicePath);
        this.onDisconnection?.(devicePath);
      }
      disconnected = true;
    }
    return disconnected;
  }
}

export class WindowsRFCOMMClient implements RFCOMMClientLike {
  private _connected = false;
  private _address = "";
  private onData: ((data: Buffer) => void) | null = null;
  private onDisconnect: ((address: string) => void) | null = null;
  private onConnection: ((address: string) => void) | null = null;

  constructor(private readonly bridge: HostBridgeClient) {
    bridge.onEvent<HostAddressEvent>("rfcomm.client.connected", (event) => {
      if (!validAddressEvent(event)) return;
      if (this._connected && this._address === event.address) return;
      this._connected = true;
      this._address = event.address;
      this.onConnection?.(event.address);
    });
    bridge.onEvent<HostAddressEvent>("rfcomm.client.disconnected", (event) => {
      const address = validAddressEvent(event) ? event.address : this._address;
      if (!address) return;
      this._connected = false;
      this.onDisconnect?.(address);
    });
    bridge.onEvent<HostClientDataEvent>("rfcomm.client.data", (event) => {
      if (isBytes(event?.data)) this.onData?.(Buffer.from(event.data));
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  get address(): string {
    return this._address;
  }

  setDataHandler(handler: (data: Buffer) => void): void {
    this.onData = handler;
  }

  setDisconnectHandler(handler: (address: string) => void): void {
    this.onDisconnect = handler;
  }

  setConnectionHandler(handler: (address: string) => void): void {
    this.onConnection = handler;
  }

  async connect(address: string, channel = 2): Promise<void> {
    await this.bridge.call("rfcomm.client.connect", { address, channel });
    if (!this._connected || this._address !== address) {
      this._address = address;
      this._connected = true;
      this.onConnection?.(address);
    }
  }

  async write(data: Buffer | Uint8Array): Promise<void> {
    if (!this._connected) throw new Error("Not connected");
    await this.bridge.call("rfcomm.client.write", {
      data: Array.from(data),
    });
  }

  async disconnect(): Promise<void> {
    await this.bridge.call(
      "rfcomm.client.disconnect",
      {},
      { timeoutMs: 5_000, priority: true },
    );
    this._connected = false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validAddressEvent(value: unknown): value is HostAddressEvent {
  return isRecord(value) && typeof value.address === "string" && value.address.length > 0;
}

function validServerConnectionEvent(value: unknown): value is HostServerConnectionEvent {
  return (
    isRecord(value) &&
    typeof value.address === "string" &&
    value.address.length > 0 &&
    typeof value.connectionId === "string"
  );
}

function isBytes(value: unknown): value is Uint8Array {
  if (value instanceof Uint8Array) return true;
  return Array.isArray(value) && value.every(
    (item) => Number.isInteger(item) && item >= 0 && item <= 255,
  );
}

function isBluetoothDevice(value: unknown): value is BluetoothDevice {
  if (!isRecord(value)) return false;
  return (
    typeof value.address === "string" &&
    typeof value.name === "string" &&
    typeof value.paired === "boolean" &&
    typeof value.connected === "boolean" &&
    typeof value.trusted === "boolean" &&
    typeof value.rssi === "number" &&
    typeof value.icon === "string"
  );
}

function isBluetoothStatus(value: unknown): value is HostBluetoothStatus {
  return (
    isRecord(value) &&
    typeof value.powered === "boolean" &&
    typeof value.discovering === "boolean" &&
    typeof value.address === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
