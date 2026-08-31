import { BlueZAdapter } from "../bluetooth/dbus-adapter";
import type { BluetoothDevice } from "../bluetooth/types";
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
  | "adapterStatus"
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
  setOnAdapterStatus?(handler: (status: { powered: boolean; discovering: boolean; address: string }) => void): void;
}

export interface RFCOMMServerLike {
  setConnectionHandler(handler: (conn: RFCOMMConnection) => void): void;
  setDisconnectionHandler(handler: (devicePath: string) => void): void;
  setDataHandler(handler: (devicePath: string, data: Buffer) => void): void;
  register(): Promise<void>;
  writeToDevice(devicePath: string, data: Buffer): Promise<void>;
  getConnections(): Map<string, RFCOMMConnection>;
  disconnectDevice?(address: string): boolean | Promise<boolean>;
}

export interface RFCOMMClientLike {
  readonly connected: boolean;
  readonly address: string;
  setDataHandler(handler: (data: Buffer) => void): void;
  setDisconnectHandler(handler: (address: string) => void): void;
  setConnectionHandler?(handler: (address: string) => void): void;
  connect(address: string, channel?: number): Promise<void>;
  write(data: Buffer | Uint8Array): Promise<void>;
  disconnect(): void | Promise<void>;
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
  platform?: NodeJS.Platform;
  adapter?: BluetoothAdapterLike;
  rfcommServer?: RFCOMMServerLike;
  rfcommClient?: RFCOMMClientLike;
  pairingAgent?: PairingAgentLike;
  timers?: BluetoothTimerScheduler;
  reconnectDelaysMs?: readonly number[];
  scanDurationMs?: number;
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
const DEFAULT_SCAN_DURATION_MS = 30_000;

interface OutboundTarget {
  address: string;
  channel: number;
}

export class BluetoothService {
  private readonly windowsHost: boolean;
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
  private rfcommClientReportsConnections = false;
  private initializationRetryTimer: BluetoothTimerHandle | null = null;
  private initializationInFlight = false;
  private scanTimer: BluetoothTimerHandle | null = null;
  private readonly scanDurationMs: number;
  private readonly suppressedOutboundAddresses = new Set<string>();

  constructor(dependencies: BluetoothServiceDependencies = {}) {
    this.windowsHost = (dependencies.platform ?? process.platform) === "win32";
    this.adapter = dependencies.adapter ?? new BlueZAdapter();
    this.rfcomm = dependencies.rfcommServer ?? new RFCOMMServer();
    this.rfcommClient = dependencies.rfcommClient ?? new RFCOMMClient();
    this.agent = dependencies.pairingAgent ?? new PairingAgent();
    this.timers = dependencies.timers ?? systemTimers;
    this.reconnectDelaysMs =
      dependencies.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.scanDurationMs = dependencies.scanDurationMs ?? DEFAULT_SCAN_DURATION_MS;

    if (this.reconnectDelaysMs.length === 0) {
      throw new Error("reconnectDelaysMs must contain at least one delay");
    }
    if (!Number.isFinite(this.scanDurationMs) || this.scanDurationMs <= 0) {
      throw new Error("scanDurationMs must be a positive duration");
    }
  }

  get rfcommServer(): RFCOMMServerLike {
    return this.rfcomm;
  }

  get rfcommOutbound(): RFCOMMClientLike {
    return this.rfcommClient;
  }

  get usesWindowsRouteSemantics(): boolean {
    return this.windowsHost;
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
    if (this._initialized || this.initializationInFlight) return;
    this.initializationInFlight = true;
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
        if (this.windowsHost) {
          this.suppressedOutboundAddresses.delete(normalizeAddress(address));
        }
        log.info(`Pairing complete for ${address}, will auto-connect RFCOMM in 3s`);
        this.scheduleAutoConnect(address, 3_000);
      });

      this.adapter.setOnDeviceConnected((address) => {
        if (
          this.windowsHost &&
          this.suppressedOutboundAddresses.has(normalizeAddress(address))
        ) {
          log.info(`Ignoring automatic RFCOMM recovery for unpaired device ${address}`);
          return;
        }
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
      if (this.windowsHost) {
        this.adapter.setOnAdapterStatus?.((status) => {
          this.emit("adapterStatus", status);
        });
      }

      this.rfcomm.setConnectionHandler((conn) => {
        if (
          this.windowsHost &&
          this.suppressedOutboundAddresses.has(normalizeAddress(conn.address))
        ) {
          log.info(`Closing inbound RFCOMM route from unpaired device ${conn.address}`);
          void Promise.resolve(this.rfcomm.disconnectDevice?.(conn.address)).catch((error) => {
            log.warn(`Unable to close suppressed inbound route from ${conn.address}: ${error}`);
          });
          return;
        }
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

        const matchesLastTarget = this.windowsHost
          ? this.lastOutboundTarget &&
            normalizeAddress(this.lastOutboundTarget.address) === normalizeAddress(address)
          : this.lastOutboundTarget?.address === address;
        if (matchesLastTarget && this.lastOutboundTarget) {
          this.scheduleReconnect(this.lastOutboundTarget);
        }
      });

      if (this.windowsHost && this.rfcommClient.setConnectionHandler) {
        this.rfcommClientReportsConnections = true;
        this.rfcommClient.setConnectionHandler((address) => {
          if (this.suppressedOutboundAddresses.has(normalizeAddress(address))) {
            log.info(`Closing outbound RFCOMM route to unpaired device ${address}`);
            void Promise.resolve(this.rfcommClient.disconnect()).catch((error) => {
              log.warn(`Unable to close suppressed outbound route to ${address}: ${error}`);
            });
            return;
          }
          this.cancelAutoConnect();
          this.cancelReconnect();
          this.lastOutboundTarget = { address, channel: 2 };
          log.info(`Native RFCOMM channel 2 connected to ${address}`);
          this.emit("deviceConnected", {
            address,
            devicePath: `rfcomm-client:${address}`,
          });
        });
      }

      await this.rfcomm.register();
      this._initialized = true;
      if (this.initializationRetryTimer) {
        this.timers.clearTimeout(this.initializationRetryTimer);
        this.initializationRetryTimer = null;
      }
      log.info("Bluetooth service initialized");
      if (this.windowsHost) {
        try {
          const target = selectWindowsConnectorTarget(await this.adapter.getDevices());
          if (target) {
            log.info(`Scheduling paired Windows connector recovery for ${target.address}`);
            this.scheduleAutoConnect(target.address, 1_000);
          }
        } catch (err) {
          log.warn(`Unable to inspect paired Windows connector targets: ${err}`);
        }
      }
    } catch (err) {
      log.warn(`Bluetooth init failed (expected on dev): ${err}`);
      if (this.windowsHost && !this._initialized) {
        this.scheduleInitializationRetry();
      }
    } finally {
      this.initializationInFlight = false;
    }
  }

  private scheduleInitializationRetry(): void {
    if (this.initializationRetryTimer) return;
    this.initializationRetryTimer = this.timers.setTimeout(() => {
      this.initializationRetryTimer = null;
      void this.initialize();
    }, 5_000);
  }

  private scheduleAutoConnect(address: string, delayMs: number): void {
    this.cancelAutoConnect();
    this.autoConnectTimer = this.timers.setTimeout(async () => {
      this.autoConnectTimer = null;
      if (this.rfcommClient.connected) return;
      try {
        await this.connectOutbound({ address, channel: 2 });
      } catch (err) {
        if (
          this.windowsHost &&
          this.suppressedOutboundAddresses.has(normalizeAddress(address))
        ) {
          log.info(`Automatic connection to unpaired device ${address} was cancelled`);
          return;
        }
        log.warn(`Auto-connect to ${address} channel 2 failed: ${err}`);
        if (this.windowsHost) {
          const target = { address, channel: 2 };
          this.lastOutboundTarget = target;
          this.scheduleReconnect(target);
        }
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
        if (
          this.windowsHost &&
          this.suppressedOutboundAddresses.has(
            normalizeAddress(currentTarget.address),
          )
        ) {
          this.cancelReconnect();
          return;
        }
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
    if (
      this.windowsHost &&
      this.suppressedOutboundAddresses.has(normalizeAddress(target.address))
    ) {
      throw new Error(`Automatic connection to unpaired device ${target.address} is suppressed`);
    }
    await this.rfcommClient.connect(target.address, target.channel);
    if (
      this.windowsHost &&
      this.suppressedOutboundAddresses.has(normalizeAddress(target.address))
    ) {
      await this.rfcommClient.disconnect();
      throw new Error(`Connection to unpaired device ${target.address} became stale`);
    }
    this.lastOutboundTarget = target;
    this.cancelReconnect();
    if (!this.rfcommClientReportsConnections) {
      this.emit("deviceConnected", {
        address: target.address,
        devicePath: `rfcomm-client:${target.address}`,
      });
    }
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
    if (this.windowsHost) this.cancelScanTimer();
    this.cancelAutoConnect();
    this.cancelReconnect();
    if (this.windowsHost && this.initializationRetryTimer) {
      this.timers.clearTimeout(this.initializationRetryTimer);
      this.initializationRetryTimer = null;
    }
    this.lastOutboundTarget = null;
    await this.adapter.powerOff();
  }

  async startScan(): Promise<void> {
    if (!this.windowsHost) {
      await this.adapter.startDiscovery();
      return;
    }
    this.cancelScanTimer();
    await this.adapter.startDiscovery();
    this.emit("adapterStatus", await this.adapter.getAdapterStatus());
    this.scanTimer = this.timers.setTimeout(async () => {
      this.scanTimer = null;
      try {
        await this.adapter.stopDiscovery();
        this.emit("adapterStatus", await this.adapter.getAdapterStatus());
      } catch (error) {
        log.warn(`Automatic Bluetooth scan stop failed: ${error}`);
      }
    }, this.scanDurationMs);
  }

  async stopScan(): Promise<void> {
    if (!this.windowsHost) {
      await this.adapter.stopDiscovery();
      return;
    }
    this.cancelScanTimer();
    await this.adapter.stopDiscovery();
    this.emit("adapterStatus", await this.adapter.getAdapterStatus());
  }

  async getDevices(): Promise<BluetoothDevice[]> {
    const devices = await this.adapter.getDevices();
    if (!this.windowsHost) return devices;
    const connectedAddresses = new Set(
      Array.from(this.getConnections().values(), (connection) =>
        connection.address.toUpperCase(),
      ),
    );
    return devices.map((device) => ({
      ...device,
      name: bluetoothDisplayName(device.name, device.address),
      connected: connectedAddresses.has(device.address.toUpperCase()),
    }));
  }

  async pair(address: string): Promise<void> {
    await this.adapter.pairDevice(address);
  }

  async connect(address: string, channel?: number): Promise<void> {
    if (this.windowsHost) {
      this.suppressedOutboundAddresses.delete(normalizeAddress(address));
    }
    this.cancelAutoConnect();
    this.cancelReconnect();
    this.lastOutboundTarget = null;
    await this.connectOutbound({ address, channel: channel ?? 2 });
  }

  async disconnect(address: string): Promise<void> {
    if (!this.windowsHost) {
      throw new Error("Manual Bluetooth disconnect is not supported on this platform");
    }
    this.cancelAutoConnect();
    this.cancelReconnect();
    this.lastOutboundTarget = null;

    const normalized = address.toUpperCase();
    let disconnected = false;
    if (
      this.rfcommClient.connected &&
      this.rfcommClient.address.toUpperCase() === normalized
    ) {
      await this.rfcommClient.disconnect();
      this.emit("deviceDisconnected", {
        address,
        devicePath: `rfcomm-client:${address}`,
      });
      disconnected = true;
    }

    if (await this.rfcomm.disconnectDevice?.(address)) disconnected = true;
    if (!disconnected) {
      throw new Error(`No active RFCOMM connection for ${address}`);
    }
  }

  async recoverOutboundConnection(address: string): Promise<void> {
    if (
      this.windowsHost &&
      this.suppressedOutboundAddresses.has(normalizeAddress(address))
    ) return;
    const target = { address, channel: 2 };
    this.cancelAutoConnect();
    this.cancelReconnect();
    this.lastOutboundTarget = target;
    try {
      await this.rfcommClient.disconnect();
    } catch (err) {
      log.warn(`Failed to close stale RFCOMM route for ${address}: ${err}`);
    }
    this.emit("deviceDisconnected", {
      address,
      devicePath: `rfcomm-client:${address}`,
    });
    this.scheduleReconnect(target);
  }

  async trust(address: string): Promise<void> {
    await this.adapter.trustDevice(address);
  }

  async unpair(address: string): Promise<void> {
    if (!this.windowsHost) {
      this.cancelAutoConnect();
      if (
        this.lastOutboundTarget?.address === address ||
        this.reconnectTarget?.address === address
      ) {
        this.cancelReconnect();
        this.lastOutboundTarget = null;
      }
      await this.adapter.removeDevice(address);
      return;
    }

    const normalized = normalizeAddress(address);
    this.suppressedOutboundAddresses.add(normalized);
    this.cancelAutoConnect();
    if (
      (this.lastOutboundTarget &&
        normalizeAddress(this.lastOutboundTarget.address) === normalized) ||
      (this.reconnectTarget &&
        normalizeAddress(this.reconnectTarget.address) === normalized)
    ) {
      this.cancelReconnect();
      this.lastOutboundTarget = null;
    }
    const hasActiveRoute = Array.from(this.getConnections().values()).some(
      (connection) => connection.address.toUpperCase() === address.toUpperCase(),
    );
    if (hasActiveRoute) await this.disconnect(address);
    await this.adapter.removeDevice(address);
  }

  getConnections(): Map<string, RFCOMMConnection> {
    if (!this.windowsHost) return this.rfcomm.getConnections();
    const connections = new Map(this.rfcomm.getConnections());
    if (this.rfcommClient.connected && this.rfcommClient.address) {
      const devicePath = `rfcomm-client:${this.rfcommClient.address}`;
      connections.set(devicePath, {
        devicePath,
        address: this.rfcommClient.address,
        fd: -1,
        stream: null,
      });
    }
    return connections;
  }

  private cancelScanTimer(): void {
    if (!this.scanTimer) return;
    this.timers.clearTimeout(this.scanTimer);
    this.scanTimer = null;
  }
}

export function bluetoothDisplayName(name: string, address: string): string {
  const trimmed = name.trim();
  const addressPattern = address.replaceAll(":", "[:\\-]?");
  const generated = new RegExp(`^Bluetooth\\s+${addressPattern}$`, "i");
  if (!trimmed || trimmed === address || generated.test(trimmed)) {
    return "Unknown Device";
  }
  return trimmed;
}

function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}

export function selectWindowsConnectorTarget(
  devices: BluetoothDevice[],
): BluetoothDevice | undefined {
  return devices.find(
    (device) => device.paired && /^nocturne(?:\s|$)/i.test(device.name.trim()),
  );
}

export function createUnavailableBluetoothService(): BluetoothService {
  const adapter: BluetoothAdapterLike = {
    async initialize() {},
    async powerOn() {},
    async powerOff() {},
    async setDiscoverable() {},
    async setPairable() {},
    async startDiscovery() {},
    async stopDiscovery() {},
    async getDevices() { return []; },
    async pairDevice() { throw new Error("Bluetooth is unavailable on this platform"); },
    async trustDevice() { throw new Error("Bluetooth is unavailable on this platform"); },
    async removeDevice() { throw new Error("Bluetooth is unavailable on this platform"); },
    async getAdapterStatus() { return { powered: false, discovering: false, address: "" }; },
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
    async writeToDevice() { throw new Error("Bluetooth is unavailable on this platform"); },
    getConnections() { return new Map(); },
    disconnectDevice() { return false; },
  };
  const rfcommClient: RFCOMMClientLike = {
    connected: false,
    address: "",
    setDataHandler() {},
    setDisconnectHandler() {},
    async connect() { throw new Error("Bluetooth is unavailable on this platform"); },
    async write() { throw new Error("Bluetooth is unavailable on this platform"); },
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
  return new BluetoothService({ adapter, rfcommServer, rfcommClient, pairingAgent });
}
