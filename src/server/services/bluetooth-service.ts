import { BlueZAdapter, type BluetoothDevice } from "../bluetooth/dbus-adapter";
import { RFCOMMServer, type RFCOMMConnection } from "../bluetooth/rfcomm-server";
import { RFCOMMClient } from "../bluetooth/rfcomm-client";
import { PairingAgent, type PairingPinEvent } from "../bluetooth/pairing-agent";
import { createLogger } from "../utils/logger";

const log = createLogger("BluetoothService");

export type BluetoothEventType =
  | "deviceFound"
  | "deviceUpdated"
  | "devicePaired"
  | "deviceConnected"
  | "deviceDisconnected"
  | "agent"
  | "pairingCancelled";

export interface BluetoothAdapterLike {
  initialize(): Promise<void>;
  powerOn(): Promise<void>;
  powerOff(): Promise<void>;
  setDiscoverable(enabled: boolean): Promise<void>;
  setPairable(enabled: boolean): Promise<void>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  getDevices(): Promise<BluetoothDevice[]>;
  pairDevice(address: string): Promise<void>;
  trustDevice(address: string): Promise<void>;
  removeDevice(address: string): Promise<void>;
  getAdapterStatus(): Promise<{
    powered: boolean;
    discovering: boolean;
    address: string;
  }>;
  setOnPairComplete(handler: (address: string) => void): void;
  setOnDeviceConnected(handler: (address: string) => void): void;
  setOnDeviceFound(handler: (device: BluetoothDevice) => void): void;
  setOnDeviceUpdated(handler: (device: BluetoothDevice) => void): void;
}

export interface RFCOMMServerLike {
  setConnectionHandler(handler: (conn: RFCOMMConnection) => void): void;
  setDisconnectionHandler(handler: (devicePath: string) => void): void;
  setDataHandler(handler: (devicePath: string, data: Buffer) => void): void;
  register(): Promise<void>;
  writeToDevice(devicePath: string, data: Buffer): void;
  getConnections(): Map<string, RFCOMMConnection>;
}

export interface RFCOMMClientLike {
  readonly connected: boolean;
  readonly address: string;
  setDataHandler(handler: (data: Buffer) => void): void;
  setDisconnectHandler(handler: (address: string) => void): void;
  connect(address: string, channel?: number): Promise<void>;
  write(data: Buffer | Uint8Array): void;
}

export interface PairingAgentLike {
  readonly pendingPin: PairingPinEvent | null;
  setOnPinDisplay(handler: (event: PairingPinEvent) => void): void;
  setOnPairingCancelled(handler: () => void): void;
  register(): Promise<void>;
  confirmPairing(): void;
  rejectPairing(): void;
}

export interface BluetoothTimerHandle {
  cancel(): void;
}

export interface BluetoothTimerScheduler {
  setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number
  ): BluetoothTimerHandle;
  clearTimeout(handle: BluetoothTimerHandle): void;
}

export interface BluetoothServiceDependencies {
  adapter?: BluetoothAdapterLike;
  rfcommServer?: RFCOMMServerLike;
  rfcommClient?: RFCOMMClientLike;
  pairingAgent?: PairingAgentLike;
  timers?: BluetoothTimerScheduler;
  reconnectDelaysMs?: readonly number[];
}

const systemTimers: BluetoothTimerScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(() => {
      void callback();
    }, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
  clearTimeout(handle) {
    handle.cancel();
  },
};

const DEFAULT_RECONNECT_DELAYS_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
] as const;

interface OutboundTarget {
  address: string;
  channel: number;
}

export class BluetoothService {
  private adapter: BluetoothAdapterLike;
  private rfcomm: RFCOMMServerLike;
  private rfcommClient: RFCOMMClientLike;
  private agent: PairingAgentLike;
  private timers: BluetoothTimerScheduler;
  private reconnectDelaysMs: readonly number[];
  private eventListeners: ((event: BluetoothEventType, data: any) => void)[] = [];
  private _initialized = false;
  private autoConnectTimer: BluetoothTimerHandle | null = null;
  private reconnectTimer: BluetoothTimerHandle | null = null;
  private reconnectAttempt = 0;
  private reconnectTarget: OutboundTarget | null = null;
  private lastOutboundTarget: OutboundTarget | null = null;

  constructor(dependencies: BluetoothServiceDependencies = {}) {
    this.adapter = dependencies.adapter ?? new BlueZAdapter();
    this.rfcomm = dependencies.rfcommServer ?? new RFCOMMServer();
    this.rfcommClient = dependencies.rfcommClient ?? new RFCOMMClient();
    this.agent = dependencies.pairingAgent ?? new PairingAgent();
    this.timers = dependencies.timers ?? systemTimers;
    this.reconnectDelaysMs =
      dependencies.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;

    if (this.reconnectDelaysMs.length === 0) {
      throw new Error("reconnectDelaysMs must contain at least one delay");
    }
  }

  get rfcommServer(): RFCOMMServerLike {
    return this.rfcomm;
  }

  get rfcommOutbound(): RFCOMMClientLike {
    return this.rfcommClient;
  }

  onEvent(listener: (event: BluetoothEventType, data: any) => void): void {
    this.eventListeners.push(listener);
  }

  private emit(event: BluetoothEventType, data: any): void {
    for (const listener of this.eventListeners) listener(event, data);
  }

  get pendingPairingPin(): PairingPinEvent | null {
    return this.agent.pendingPin;
  }

  confirmPairing(): void {
    this.agent.confirmPairing();
  }

  rejectPairing(): void {
    this.agent.rejectPairing();
  }

  async initialize(): Promise<void> {
    try {
      await this.adapter.initialize();
      await this.adapter.powerOn();
      await this.adapter.setDiscoverable(true);
      await this.adapter.setPairable(true);

      this.agent.setOnPinDisplay((event) => {
        log.info(`PIN display: ${event.address} (${event.name}) pin=${event.pin}`);
        this.emit("agent", event);
      });
      this.agent.setOnPairingCancelled(() => {
        log.info("Pairing cancelled by remote device");
        this.emit("pairingCancelled", {});
      });

      await this.agent.register();

      this.adapter.setOnPairComplete((address) => {
        log.info(`Pairing complete for ${address}, will auto-connect RFCOMM in 3s`);
        this.scheduleAutoConnect(address, 3_000);
      });

      this.adapter.setOnDeviceConnected((address) => {
        if (
          this.rfcommClient.connected &&
          this.rfcommClient.address === address
        ) {
          return;
        }
        log.info(
          `Paired device ${address} connected, auto-connecting RFCOMM channel 2 in 2s`
        );
        this.scheduleAutoConnect(address, 2_000);
      });

      this.adapter.setOnDeviceFound((device) => {
        this.emit("deviceFound", device);
      });
      this.adapter.setOnDeviceUpdated((device) => {
        this.emit("deviceUpdated", device);
      });

      this.rfcomm.setConnectionHandler((conn) => {
        log.info(`Inbound RFCOMM from ${conn.address}`);
        this.emit("deviceConnected", {
          address: conn.address,
          devicePath: conn.devicePath,
        });
      });

      this.rfcomm.setDisconnectionHandler((devicePath) => {
        log.info(`Inbound RFCOMM disconnected: ${devicePath}`);
        this.emit("deviceDisconnected", { devicePath });
      });

      this.rfcommClient.setDisconnectHandler((address) => {
        log.info(`Outbound RFCOMM disconnected from ${address}`);
        this.emit("deviceDisconnected", {
          address,
          devicePath: `rfcomm-client:${address}`,
        });

        if (this.lastOutboundTarget?.address === address) {
          this.scheduleReconnect(this.lastOutboundTarget);
        }
      });

      await this.rfcomm.register();
      this._initialized = true;
      log.info("Bluetooth service initialized");
    } catch (err) {
      log.warn(`Bluetooth init failed (expected on dev): ${err}`);
    }
  }

  private scheduleAutoConnect(address: string, delayMs: number): void {
    this.cancelAutoConnect();
    this.autoConnectTimer = this.timers.setTimeout(async () => {
      this.autoConnectTimer = null;
      if (this.rfcommClient.connected) return;
      try {
        await this.connect(address, 2);
      } catch (err) {
        log.warn(`Auto-connect to ${address} channel 2 failed: ${err}`);
      }
    }, delayMs);
  }

  private scheduleReconnect(target: OutboundTarget): void {
    if (this.reconnectTimer) return;

    this.reconnectTarget = target;
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1
    );
    const delayMs = this.reconnectDelaysMs[delayIndex];
    log.info(
      `Scheduling RFCOMM reconnect to ${target.address} channel ${target.channel} in ${delayMs}ms`
    );

    this.reconnectTimer = this.timers.setTimeout(async () => {
      this.reconnectTimer = null;
      const currentTarget = this.reconnectTarget;
      if (!currentTarget || this.rfcommClient.connected) {
        this.cancelReconnect();
        return;
      }

      try {
        await this.connectOutbound(currentTarget);
        log.info(`RFCOMM reconnect succeeded for ${currentTarget.address}`);
      } catch (err) {
        this.reconnectAttempt++;
        log.warn(`RFCOMM reconnect failed for ${currentTarget.address}: ${err}`);
        this.scheduleReconnect(currentTarget);
      }
    }, delayMs);
  }

  private cancelAutoConnect(): void {
    if (!this.autoConnectTimer) return;
    this.timers.clearTimeout(this.autoConnectTimer);
    this.autoConnectTimer = null;
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.reconnectTarget = null;
  }

  private async connectOutbound(target: OutboundTarget): Promise<void> {
    await this.rfcommClient.connect(target.address, target.channel);
    this.lastOutboundTarget = target;
    this.cancelReconnect();
    this.emit("deviceConnected", {
      address: target.address,
      devicePath: `rfcomm-client:${target.address}`,
    });
  }

  get initialized(): boolean {
    return this._initialized;
  }

  async getStatus() {
    return this.adapter.getAdapterStatus();
  }

  async powerOn(): Promise<void> {
    await this.adapter.powerOn();
  }

  async powerOff(): Promise<void> {
    this.cancelAutoConnect();
    this.cancelReconnect();
    this.lastOutboundTarget = null;
    await this.adapter.powerOff();
  }

  async startScan(): Promise<void> {
    await this.adapter.startDiscovery();
  }

  async stopScan(): Promise<void> {
    await this.adapter.stopDiscovery();
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    return this.adapter.getDevices();
  }

  async pair(address: string): Promise<void> {
    await this.adapter.pairDevice(address);
  }

  async connect(address: string, channel?: number): Promise<void> {
    this.cancelAutoConnect();
    this.cancelReconnect();
    this.lastOutboundTarget = null;
    await this.connectOutbound({ address, channel: channel ?? 2 });
  }

  async trust(address: string): Promise<void> {
    await this.adapter.trustDevice(address);
  }

  async unpair(address: string): Promise<void> {
    this.cancelAutoConnect();
    if (
      this.lastOutboundTarget?.address === address ||
      this.reconnectTarget?.address === address
    ) {
      this.cancelReconnect();
      this.lastOutboundTarget = null;
    }
    await this.adapter.removeDevice(address);
  }

  getConnections(): Map<string, RFCOMMConnection> {
    return this.rfcomm.getConnections();
  }
}
