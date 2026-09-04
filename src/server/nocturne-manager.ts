import { RPCClient, type RPCClientDelegate } from "./rpc/rpc-client";
import {
  SpotifyService,
  type SpotifySkipPreferenceStore,
} from "./services/spotify-service";
import {
  normalizeSpotifyCommand,
  SpotifyCommandDispatcher,
} from "./services/spotify-commands";
import { SpotifyWebSocketService, type SpotifyWebSocketDelegate } from "./services/spotify-websocket";
import { OTAService, type ConnectorUpdateCheckResponse } from "./services/ota-service";
import {
  carThingOtaVersionLanes,
  CarThingOTAService,
  type CarThingAvailableUpdate,
  type CarThingOtaAsset,
  type CarThingOtaKind,
  type CarThingOtaVersionLanes,
} from "./services/car-thing-ota-service";
import { BluetoothService } from "./services/bluetooth-service";
import { AuthService, type SessionProtector } from "./services/auth-service";
import { SetupStateService } from "./services/setup-state-service";
import { AnalyticsService } from "./services/analytics-service";
import { SpotifyDatabaseStorage } from "./services/spotify-database";
import { createLogger } from "./utils/logger";
import { getConnectorVersion } from "./utils/version";
import { existsSync, statSync } from "fs";
import { MAX_OTA_TRANSFER_WINDOW_BYTES } from "./services/ota-transfer";
import type { HostBridgeClient } from "./platform/host-bridge";
import {
  SystemMediaService,
  type SystemMediaPreferenceStore,
} from "./services/system-media-service";

const log = createLogger("NocturneManager");
const KEEP_ALIVE_RPC_TIMEOUT_MS = 5_000;

interface DeviceConnection {
  rpcClient: RPCClient;
  deviceInfo: DeviceInfo | null;
}

export interface DeviceInfo {
  device: string;
  version: string;
  fullVersion: string | null;
  imageVersion: string | null;
  bandaidVersion: string | null;
  buildDate: string | null;
  gitHash: string | null;
  serialNumber: string | null;
}

export interface CarThingOtaRequestParams {
  currentVersion: string | null;
  imageVersion: string | null;
  bandaidVersion: string | null;
  channel: string;
  targetVersion: string | null;
  targetKind: CarThingOtaKind | null;
}

type WSBroadcast = (type: string, data: any) => void;

export interface NocturneManagerDependencies {
  platform?: NodeJS.Platform;
  bluetoothService?: BluetoothService;
  hostBridge?: HostBridgeClient;
  sessionProtector?: SessionProtector;
  spotifySkipPreferenceStore?: SpotifySkipPreferenceStore;
  systemMediaPreferenceStore?: SystemMediaPreferenceStore;
  carThingOtaService?: CarThingOTAService;
}

export class NocturneManager implements RPCClientDelegate, SpotifyWebSocketDelegate {
  readonly authService: AuthService;
  readonly spotifyService: SpotifyService;
  readonly analyticsService: AnalyticsService;
  private spotifyCommands: SpotifyCommandDispatcher;
  private spotifyWebSocket: SpotifyWebSocketService;
  readonly otaService = new OTAService();
  readonly carThingOtaService: CarThingOTAService;
  readonly bluetoothService: BluetoothService;
  readonly setupStateService = new SetupStateService();
  readonly systemMediaService: SystemMediaService | null;

  private connections = new Map<string, DeviceConnection>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveFailures = new Map<string, number>();
  private didSendInitialPing = false;
  private wsBroadcast: WSBroadcast | null = null;
  private downloadedOTAFilePath: string | null = null;
  private cachedPlayerState: any = null;
  private connectorUpdateCheckPromise: Promise<ConnectorUpdateCheckResponse> | null = null;
  private activeCarThingUpdate: CarThingAvailableUpdate | null = null;
  private carThingInstallPromise: Promise<void> | null = null;
  private carThingResumePromise: Promise<void> | null = null;
  private carThingRangeTasks = new Map<string, AbortController>();
  private carThingOtaGeneration = 0;
  private pendingHostVolumePercent: number | null = null;
  private hostVolumeReportTask: Promise<void> | null = null;
  private systemMediaModeTask: Promise<void> = Promise.resolve();
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: NocturneManagerDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.bluetoothService = dependencies.bluetoothService ?? new BluetoothService();
    this.carThingOtaService =
      dependencies.carThingOtaService ?? new CarThingOTAService();
    this.authService = new AuthService({
      sessionProtector: dependencies.sessionProtector,
    });
    const dbStorage = new SpotifyDatabaseStorage(this.authService.client);
    this.spotifyService = new SpotifyService(
      dbStorage,
      () => this.authService.currentUser?.id ?? null,
      dependencies.spotifySkipPreferenceStore,
      this.platform === "win32",
    );
    this.analyticsService = new AnalyticsService(this.authService.client);
    this.spotifyCommands = new SpotifyCommandDispatcher(this.spotifyService);
    this.spotifyWebSocket = new SpotifyWebSocketService(this.spotifyService);
    this.spotifyWebSocket.setDelegate(this);
    this.systemMediaService = dependencies.hostBridge
      ? new SystemMediaService(dependencies.hostBridge, {
          sendEvent: (topic, data) => this.broadcastToDevices(topic, data),
          sendVolume: (volumePercent) =>
            this.queueHostVolumeUpdate(volumePercent),
        }, dependencies.systemMediaPreferenceStore)
      : null;

    this.authService.onAuthStateChange(async (user) => {
      await this.spotifyService.checkAuthStatus();
      if (user) {
        this.analyticsService.syncPendingAnalytics().catch((err) => {
          log.warn(`Analytics sync failed: ${err}`);
        });
      }
    });

    this.spotifyService.onAuthStateChange((state) => {
      this.systemMediaModeTask = this.systemMediaModeTask
        .catch((error) => {
          log.warn(`Previous host Spotify media transition failed: ${error}`);
        })
        .then(async () => {
          await this.systemMediaService?.setForcedOn(
            this.spotifyService.isSpotifySkipped,
          );
          await this.systemMediaService?.setSpotifyLinked(state.status === "linked");
        })
        .catch((error) => {
          log.warn(`Host Spotify media state failed: ${error}`);
        });
      this.broadcastToWebSocket("spotify.auth.status", state);
      this.broadcastToDevices("spotify.auth.status", {
        authenticated: state.status === "linked",
        skipped: state.status === "skipped",
      });

      if (state.status === "loading" || state.status === "polling") {
        this.broadcastToDevices("spotify.auth.started", {
          status: "authorization_started",
        });
      }

      if (state.status === "linked") {
        this.broadcastToDevices("spotify.auth.completed", {
          authenticated: true,
        });
        this.spotifyWebSocket.connect().catch((err) => log.error(`WebSocket connect failed: ${err}`));
      } else {
        this.spotifyWebSocket.disconnect();
      }
    });
  }

  setWSBroadcast(broadcast: WSBroadcast): void {
    this.wsBroadcast = broadcast;
    this.otaService.setConnectorStatusListener((status) => {
      this.broadcastToWebSocket("connector.ota.status", status);
    });
  }

  private broadcastToWebSocket(type: string, data: any): void {
    this.wsBroadcast?.(type, data);
  }

  async initializeOffline(): Promise<void> {
    try {
      this.activeCarThingUpdate = await this.carThingOtaService.activeUpdate();
    } catch (err) {
      log.warn(`Discarding invalid persisted Car Thing OTA state: ${errorMessage(err)}`);
      await this.carThingOtaService.clearActiveUpdate(false);
      this.activeCarThingUpdate = null;
    }
    if (this.systemMediaService) {
      try {
        await this.systemMediaService.setForcedOn(
          this.spotifyService.isSpotifySkipped,
        );
        await this.systemMediaService.start();
      } catch (err) {
        log.warn(`System media initialization failed: ${errorMessage(err)}`);
      }
    }
    await this.bluetoothService.initialize();

    this.bluetoothService.rfcommServer.setDataHandler((devicePath, data) => {
      const conn = this.connections.get(devicePath);
      if (conn) {
        void conn.rpcClient.handleIncomingData(data).catch((error) => {
          log.error(`Inbound RPC handling failed for ${devicePath}: ${errorMessage(error)}`);
        });
      }
    });

    this.bluetoothService.rfcommOutbound.setDataHandler((data) => {
      const address = this.bluetoothService.rfcommOutbound.address;
      const devicePath = `rfcomm-client:${address}`;
      const conn = this.connections.get(devicePath);
      if (conn) {
        void conn.rpcClient.handleIncomingData(data).catch((error) => {
          log.error(`Outbound RPC handling failed for ${devicePath}: ${errorMessage(error)}`);
        });
      }
    });

    this.bluetoothService.onEvent((event, data) => {
      if (event === "deviceConnected") {
        this.handleNewConnection(data.devicePath, data.address);
      } else if (event === "deviceDisconnected") {
        this.handleDisconnection(data.devicePath);
      }
      this.broadcastToWebSocket(`bluetooth.${event}`, data);
    });

    log.info("NocturneManager offline init complete (Bluetooth ready)");
  }

  async initializeOnline(): Promise<void> {
    await this.authService.initialize();
    if (this.connections.size > 0) {
      await this.sendAppReady();
    }
    log.info("NocturneManager online init complete (auth restored or pending)");
  }

  private handleNewConnection(devicePath: string, address: string): void {
    const isOutbound = devicePath.startsWith("rfcomm-client:");
    const rpcClient = new RPCClient(devicePath, "base64-newline", {
      preserveConnectionWireFormat: this.platform === "win32",
    });
    rpcClient.setDelegate(this);
    rpcClient.setSocket({
      write: (data: Buffer | Uint8Array) => {
        if (isOutbound) {
          return this.bluetoothService.rfcommOutbound.write(Buffer.from(data));
        }
        return this.bluetoothService.rfcommServer.writeToDevice(devicePath, Buffer.from(data));
      },
      end: () => {},
    });

    this.connections.set(devicePath, { rpcClient, deviceInfo: null });
    this.keepAliveFailures.delete(devicePath);
    this.didSendInitialPing = false;
    this.startKeepAlive(15);

    this.broadcastToWebSocket("device.connected", { devicePath, address });

    setTimeout(() => this.sendInitialPing(devicePath), 500);
  }

  private handleDisconnection(devicePath: string): void {
    const conn = this.connections.get(devicePath);
    if (conn) {
      conn.rpcClient.cleanup();
      this.connections.delete(devicePath);
      this.keepAliveFailures.delete(devicePath);
    }

    if (this.connections.size === 0) {
      this.stopKeepAlive();
      for (const controller of this.carThingRangeTasks.values()) {
        controller.abort();
      }
      this.carThingRangeTasks.clear();
    }

    this.broadcastToWebSocket("device.disconnected", { devicePath });
  }

  private async sendInitialPing(connectionID: string): Promise<void> {
    const conn = this.connections.get(connectionID);
    if (!conn) return;

    try {
      await conn.rpcClient.call("ping", { message: "RPi connected" });
      const deviceInfo = normalizeDeviceInfo(
        await conn.rpcClient.call("device.info", {}),
      );
      conn.deviceInfo = deviceInfo;

      log.info(`Initial ping sent to ${connectionID}`);
      this.broadcastToWebSocket("device.info", deviceInfo);

      this.recordConnectionAnalytics(deviceInfo);

      await this.sendAppReady();
      void this.resumePreparedCarThingOta(connectionID);
      void this.checkConnectorUpdateForConnection(connectionID);
    } catch (err) {
      log.error(`Initial ping failed for ${connectionID}: ${err}`);
    }
  }

  private async checkConnectorUpdateForConnection(connectionID: string): Promise<void> {
    const status = this.otaService.getConnectorUpdateStatus();
    if (!status.supported) {
      log.info("Skipping connector update notification check: A/B boot is not available");
      return;
    }
    if (status.inProgress) {
      log.info("Skipping connector update notification check: connector update already in progress");
      return;
    }
    if (status.rebootRequired) {
      log.info("Skipping connector update notification check: connector update already staged");
      return;
    }

    let update: ConnectorUpdateCheckResponse;
    try {
      update = await this.getConnectorUpdateCheck();
    } catch (err) {
      log.warn(`Connector update check on Car Thing connect failed: ${err}`);
      return;
    }

    if (!update.updateAvailable || !update.version) {
      log.info(`No connector update notification sent to ${connectionID}: ${update.message ?? "no update available"}`);
      return;
    }

    const conn = this.connections.get(connectionID);
    if (!conn) return;

    const payload = this.connectorUpdateNotificationPayload(update);
    try {
      await conn.rpcClient.sendEvent("notification.show", payload);
      log.info(`Sent connector update notification (${update.version}) to ${connectionID}`);
    } catch (err) {
      log.warn(`Failed to send connector update notification to ${connectionID}: ${err}`);
    }
  }

  private getConnectorUpdateCheck(): Promise<ConnectorUpdateCheckResponse> {
    if (!this.connectorUpdateCheckPromise) {
      this.connectorUpdateCheckPromise = this.otaService
        .checkConnectorUpdate("stable")
        .finally(() => {
          this.connectorUpdateCheckPromise = null;
        });
    }
    return this.connectorUpdateCheckPromise;
  }

  private connectorUpdateNotificationPayload(update: ConnectorUpdateCheckResponse): Record<string, unknown> {
    const displayVersion = update.version?.replace(/^v/i, "") ?? "new";
    return {
      id: `connector.ota.available.${update.version}`,
      title: "Connector update available",
      body: `Version ${displayVersion} is ready. Open Connector Settings to install it.`,
      category: "connector.ota.available",
      timestamp: Date.now(),
      version: update.version,
      currentVersion: update.currentVersion,
      channel: update.channel,
    };
  }

  private recordConnectionAnalytics(deviceInfo: any): void {
    const mfiSerial =
      typeof deviceInfo?.serialNumber === "string" && deviceInfo.serialNumber.length > 0
        ? deviceInfo.serialNumber
        : "unknown";
    const firmwareVersion =
      typeof deviceInfo?.version === "string" && deviceInfo.version.length > 0
        ? deviceInfo.version
        : "unknown";
    const shortSerial = mfiSerial.length >= 4 ? mfiSerial.slice(-4) : mfiSerial;
    const deviceName = `Nocturne (${shortSerial})`;
    const userId = this.authService.currentUser?.id ?? null;
    const appVersion = getConnectorVersion();

    this.analyticsService
      .recordDailyActive({
        deviceSerial: mfiSerial,
        userId,
        appVersion,
        firmwareVersion,
        phoneVersion: "Connector",
      })
      .catch((err) => log.warn(`recordDailyActive failed: ${err}`));

    this.analyticsService
      .trackEvent({
        deviceSerial: mfiSerial,
        userId,
        eventType: "connection.established",
        eventData: {
          device: deviceName,
          mfi_serial: mfiSerial,
          firmware_version: firmwareVersion,
        },
      })
      .catch((err) => log.warn(`trackEvent connection.established failed: ${err}`));
  }

  private async sendAppReady(): Promise<void> {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzOffset = -now.getTimezoneOffset() * 60;
    const isAuthenticated = this.spotifyService.authState.status === "linked";
    const spotifySkipped = this.spotifyService.authState.status === "skipped";
    const pad = (n: number) => String(n).padStart(2, "0");
    const datetime = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const tzAbbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const isDST = now.getTimezoneOffset() < Math.max(jan, jul);

    await this.broadcastToDevices("spotify.auth.status", {
      authenticated: isAuthenticated,
      skipped: spotifySkipped,
    });

    await this.broadcastToDevices("app.ready", {
      platform: "web",
      timestamp: Date.now(),
      spotifySkipped,
      datetime,
      time,
      timezone: {
        identifier: tz,
        secondsFromGMT: tzOffset,
        abbreviation: tzAbbr,
        isDaylightSavingTime: isDST,
      },
    });

    await this.systemMediaService?.replayLatest();

    log.info("Sent app.ready in response to daemon.ready");
  }

  private startKeepAlive(intervalSec: number): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(async () => {
      for (const [id, conn] of this.connections) {
        try {
          if (this.platform !== "win32") {
            await conn.rpcClient.call("ping", {
              message: "keepalive",
              volumePercent: 50,
            });
            continue;
          }
          await conn.rpcClient.call(
            "ping",
            {
              message: "keepalive",
              volumePercent: this.systemMediaService?.currentVolumePercent ?? 50,
            },
            KEEP_ALIVE_RPC_TIMEOUT_MS,
          );
          this.keepAliveFailures.delete(id);
        } catch (err) {
          log.warn(`Keep-alive failed for ${id}: ${err}`);
          if (this.platform !== "win32") continue;
          if (!this.connections.has(id)) {
            this.keepAliveFailures.delete(id);
            continue;
          }
          const failures = (this.keepAliveFailures.get(id) ?? 0) + 1;
          this.keepAliveFailures.set(id, failures);
          if (failures >= 2 && id.startsWith("rfcomm-client:")) {
            const address = id.slice("rfcomm-client:".length);
            this.keepAliveFailures.delete(id);
            log.warn(`Resetting stale outbound RFCOMM route for ${address}`);
            log.warn("Restarting the Windows connector sidecar to release the stale RFCOMM route");
            setTimeout(() => process.exit(75), 0);
            return;
          }
        }
      }
    }, intervalSec * 1000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async broadcastToDevices(topic: string, data: any): Promise<void> {
    for (const [id, conn] of this.connections) {
      try {
        await conn.rpcClient.sendEvent(topic, data);
      } catch (err) {
        log.warn(`Broadcast to ${id} failed: ${err}`);
      }
    }
  }

  private queueHostVolumeUpdate(volumePercent: number): Promise<void> {
    this.pendingHostVolumePercent = volumePercent;
    if (!this.hostVolumeReportTask) {
      this.hostVolumeReportTask = this.flushHostVolumeUpdates().finally(() => {
        this.hostVolumeReportTask = null;
        if (this.pendingHostVolumePercent !== null) {
          void this.queueHostVolumeUpdate(this.pendingHostVolumePercent);
        }
      });
    }
    return this.hostVolumeReportTask;
  }

  private async flushHostVolumeUpdates(): Promise<void> {
    while (this.pendingHostVolumePercent !== null) {
      const volumePercent = this.pendingHostVolumePercent;
      this.pendingHostVolumePercent = null;
      for (const [id, conn] of this.connections) {
        try {
          await conn.rpcClient.call("device.volume.update", {
            volume_percent: volumePercent,
          });
        } catch (err) {
          log.warn(`Host volume update to ${id} failed: ${errorMessage(err)}`);
        }
      }
    }
  }

  async onCall(id: string, method: string, params: unknown): Promise<{ result?: unknown; error?: string }> {
    log.info(`RPC call: ${method}`);
    const p = (params as any) ?? {};
    const normalizedMethod = normalizeSpotifyCommand(method);

    try {
      if (method === "ping") {
        return { result: { pong: p.message || "pong" } };
      }

      if (method === "device.info") {
        return { result: { device: "nocturne-connector", version: getConnectorVersion() } };
      }

      if (normalizedMethod === "spotify.auth.get_status") {
        return {
          result: {
            authenticated: this.spotifyService.authState.status === "linked",
            skipped: this.spotifyService.authState.status === "skipped",
          },
        };
      }

      if (normalizedMethod.startsWith("spotify.")) {
        const result = await this.spotifyCommands.dispatch(normalizedMethod, p);
        return { result };
      }

      if (method.startsWith("media.control.") && this.systemMediaService) {
        const status = await this.systemMediaService.handleControl(method);
        if (status) return { result: { status } };
      }

      if (method === "device.ota.check") {
        const currentVersion = p.currentVersion ?? "unknown";
        const result = await this.otaService.checkForUpdates(currentVersion, "beta");
        return {
          result: {
            updateAvailable: result.updateAvailable,
            version: result.version,
            channel: result.channel,
            metadata: result.metadata,
          },
        };
      }

      if (method === "device.ota.download") {
        const filePath = await this.otaService.downloadUpdate(
          p.currentVersion ?? "unknown",
          p.targetVersion ?? "unknown"
        );
        this.downloadedOTAFilePath = filePath;
        const stat = statSync(filePath);
        const md5 = this.otaService.calculateMD5(filePath);

        await this.broadcastToDevices("device.ota.package_state", {
          state: "download_success",
          name: "nocturne-os",
          version: p.targetVersion,
          hash: md5,
          size: stat.size,
        });

        return { result: { success: true, message: "Update downloaded, ready for transfer" } };
      }

      if (method === "device.ota.transfer") {
        const active =
          this.activeCarThingUpdate ??
          (await this.carThingOtaService.activeUpdate());
        if (active) {
          this.activeCarThingUpdate = active;
          const chunk = await this.carThingOtaService.readPrimaryChunk(
            active,
            integerParam(p.offset, 0),
            integerParam(p.size, MAX_OTA_TRANSFER_WINDOW_BYTES),
          );
          return { result: { data: chunk } };
        }
        if (!this.downloadedOTAFilePath) return { error: "No OTA file available" };
        const chunk = this.otaService.readChunk(
          this.downloadedOTAFilePath,
          p.offset ?? 0,
          p.size ?? MAX_OTA_TRANSFER_WINDOW_BYTES
        );
        return { result: { data: chunk } };
      }

      if (method === "device.timezone.get") {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const offset = -new Date().getTimezoneOffset() * 60;
        return {
          result: {
            identifier: tz,
            secondsFromGMT: offset,
            abbreviation: "",
            isDaylightSavingTime: false,
          },
        };
      }

      if (method === "device.time.get") {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const datetime = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
        const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        return { result: { datetime, time } };
      }

      log.warn(`Unknown method: ${method}`);
      return { error: `Unknown method: ${method}` };
    } catch (err: any) {
      log.error(`RPC call ${method} failed: ${err.message}`);
      return { error: err.message };
    }
  }

  onEvent(topic: string, data: unknown): void {
    if (topic === "chunk.retransmit_request") {
      const d = data as any;
      const messageId = d?.message_id;
      const chunkIdx = d?.chunk_idx;
      if (messageId != null && chunkIdx != null) {
        for (const [, conn] of this.connections) {
          conn.rpcClient.retransmitChunk(messageId, chunkIdx).catch(() => {});
        }
      }
    } else if (topic === "daemon.ready") {
      this.sendAppReady().catch((err) => log.error(`Failed to send app.ready: ${err}`));
    } else if (topic === "ota.request_check") {
      void this.handleCarThingOtaCheck(data);
    } else if (topic === "ota.request_install") {
      if (this.carThingInstallPromise || this.carThingResumePromise) {
        log.info("Ignoring duplicate OTA install request while one is active");
        return;
      }
      const install = this.handleCarThingOtaInstall(data)
        .catch((err) => {
          log.error(`Car Thing OTA install request failed: ${errorMessage(err)}`);
        })
        .finally(() => {
          if (this.carThingInstallPromise === install) {
            this.carThingInstallPromise = null;
          }
        });
      this.carThingInstallPromise = install;
    } else if (topic === "ota.asset_range") {
      void this.handleCarThingAssetRange(data);
    } else if (topic === "ota.asset_range_abandon") {
      const requestId = stringParam(asUnknownRecord(data)?.requestId)
        ?? stringParam(asUnknownRecord(data)?.request_id);
      if (requestId) {
        this.carThingRangeTasks.get(requestId)?.abort();
        this.carThingRangeTasks.delete(requestId);
      }
    } else if (topic === "ota.complete") {
      this.carThingOtaGeneration++;
      for (const controller of this.carThingRangeTasks.values()) controller.abort();
      this.carThingRangeTasks.clear();
      this.activeCarThingUpdate = null;
      void this.carThingOtaService
        .clearActiveUpdate(true)
        .catch((err) => log.warn(`Failed to clean completed OTA state: ${err}`));
    } else if (topic === "ota.error") {
      this.carThingOtaGeneration++;
      for (const controller of this.carThingRangeTasks.values()) controller.abort();
      this.carThingRangeTasks.clear();
      this.activeCarThingUpdate = null;
      void this.carThingOtaService
        .clearActiveUpdate(true)
        .catch((err) => log.warn(`Failed to clean failed OTA state: ${err}`));
    }
  }

  private otaRPCClient(): RPCClient | null {
    return this.connections.values().next().value?.rpcClient ?? null;
  }

  private async handleCarThingOtaCheck(data: unknown): Promise<void> {
    const client = this.otaRPCClient();
    if (!client) return;
    const params = carThingOtaRequestParams(data);
    const versions = this.carThingOtaVersions(params);

    if (!versions) {
      await client.sendEvent("ota.check_result", {
        available: false,
        channel: params.channel,
        requiresReflash: false,
        error: "Device version is unavailable",
      });
      return;
    }

    try {
      const check = await this.carThingOtaService.checkUpdate(
        versions.currentVersion,
        params.channel,
        versions.imageVersion,
        versions.bandaidVersion,
      );
      await this.sendCarThingCheckResult(client, check.update, check.channel);
    } catch (err) {
      const message = errorMessage(err);
      log.error(`Car Thing OTA check failed: ${message}`);
      await client.sendEvent("ota.check_result", {
        available: false,
        channel: params.channel,
        requiresReflash: false,
        error: message,
      });
    }
  }

  private async handleCarThingOtaInstall(data: unknown): Promise<void> {
    const client = this.otaRPCClient();
    if (!client) return;
    const params = carThingOtaRequestParams(data);
    const versions = this.carThingOtaVersions(params);
    if (!versions) throw new Error("Device version is unavailable");

    const generation = this.carThingOtaGeneration;
    let beganUpdateId: string | null = null;
    let rememberedUpdate = false;
    try {
      const check = await this.carThingOtaService.checkUpdate(
        versions.currentVersion,
        params.channel,
        versions.imageVersion,
        versions.bandaidVersion,
      );
      const update = check.update;
      if (!update) throw new Error("No update is available to install");
      if (
        (params.targetVersion && update.version !== params.targetVersion) ||
        (params.targetKind && update.kind !== params.targetKind)
      ) {
        await this.sendCarThingCheckResult(client, update, check.channel);
        log.warn(
          `Refusing changed OTA target ${params.targetVersion ?? "*"}/${params.targetKind ?? "*"}; latest is ${update.version}/${update.kind}`,
        );
        return;
      }
      if (update.requiresReflash) {
        throw new Error("This update requires a full reflash");
      }

      const begin = await client.call("ota.begin", {
        kind: update.kind,
        updateId: update.updateId,
        updateUrlBase: update.updateUrlBase,
        expectedSha256: update.expectedSha256,
        expectedSize: update.expectedSize,
      });
      beganUpdateId = update.updateId;
      const resumeFromOffset = integerParam(
        asUnknownRecord(begin)?.resumeFromOffset ??
          asUnknownRecord(begin)?.resume_from_offset,
        0,
      );

      let lastReportedPercent = -1;
      let lastReportedAt = 0;
      await this.carThingOtaService.prepareUpdateArtifacts(
        update,
        async (downloaded, total) => {
          const percent = total > 0 ? Math.floor((downloaded / total) * 100) : 0;
          const now = Date.now();
          if (
            percent < 100 &&
            percent < lastReportedPercent + 5 &&
            now - lastReportedAt < 15_000
          ) {
            return;
          }
          lastReportedPercent = percent;
          lastReportedAt = now;
          try {
            await client.call("ota.download_progress", {
              updateId: update.updateId,
              percent,
            });
          } catch (err) {
            log.warn(`OTA download progress report failed: ${errorMessage(err)}`);
          }
        },
      );
      if (generation !== this.carThingOtaGeneration) {
        throw new Error("OTA session ended while assets were downloading");
      }

      await this.carThingOtaService.rememberActiveUpdate(update);
      rememberedUpdate = true;
      this.activeCarThingUpdate = update;
      if (generation !== this.carThingOtaGeneration) {
        await this.carThingOtaService.clearActiveUpdate(true);
        this.activeCarThingUpdate = null;
        rememberedUpdate = false;
        throw new Error("OTA session ended before the package became ready");
      }
      await this.sendCarThingPackageReady(client, update, resumeFromOffset);
    } catch (err) {
      const message = errorMessage(err);
      log.error(`Car Thing OTA install failed: ${message}`);
      if (beganUpdateId) {
        try {
          await client.call("ota.abandon", { updateId: beganUpdateId });
          if (rememberedUpdate) {
            await this.carThingOtaService.clearActiveUpdate(false);
            this.activeCarThingUpdate = null;
            rememberedUpdate = false;
          }
        } catch (abandonError) {
          log.warn(`Failed to abandon OTA ${beganUpdateId}: ${errorMessage(abandonError)}`);
        }
      }
      if (rememberedUpdate) {
        const replacement = Array.from(this.connections.entries()).find(
          ([, connection]) => connection.rpcClient !== client,
        );
        if (replacement) {
          await this.resumePreparedCarThingOta(replacement[0], true);
        }
      }
      throw err;
    }
  }

  private async handleCarThingAssetRange(data: unknown): Promise<void> {
    const client = this.otaRPCClient();
    if (!client) return;
    const params = asUnknownRecord(data);
    const requestId =
      stringParam(params?.requestId) ?? stringParam(params?.request_id);
    if (!requestId) return;

    const controller = new AbortController();
    let replied = false;
    let failurePartIndex = 0;
    let failureOffset = 0;
    this.carThingRangeTasks.get(requestId)?.abort();
    this.carThingRangeTasks.set(requestId, controller);
    try {
      const update =
        this.activeCarThingUpdate ??
        (await this.carThingOtaService.activeUpdate());
      if (!update) throw new Error("No active OTA range session");
      this.activeCarThingUpdate = update;
      const updateId =
        stringParam(params?.updateId) ?? stringParam(params?.update_id);
      if (updateId !== update.updateId) throw new Error("Unknown OTA update ID");
      const assetName = stringParam(params?.asset);
      const asset = update.rangeAssets.find((item) => item.name === assetName);
      if (!asset) throw new Error(`Unknown OTA range asset ${assetName ?? ""}`);
      const ranges = parseRanges(params?.ranges, asset);

      await client.call("ota.asset_range_reply", {
        requestId,
        totalSize: asset.size,
        parts: ranges,
      });
      replied = true;

      for (let partIndex = 0; partIndex < ranges.length; partIndex++) {
        const range = ranges[partIndex];
        if (!range) continue;
        let cursor = 0;
        while (cursor < range.length) {
          if (controller.signal.aborted) return;
          const length = Math.min(
            MAX_OTA_TRANSFER_WINDOW_BYTES,
            range.length - cursor,
          );
          const offset = range.start + cursor;
          failurePartIndex = partIndex;
          failureOffset = offset;
          const bytes = await this.carThingOtaService.readAssetRange(
            update,
            asset,
            offset,
            length,
            controller.signal,
          );
          cursor += length;
          const last =
            partIndex === ranges.length - 1 && cursor === range.length;
          await client.call("ota.asset_range_chunk", {
            requestId,
            partIndex,
            offset,
            bytes,
            last,
          }, 60_000);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = errorMessage(err);
      log.error(`OTA asset range ${requestId} failed: ${message}`);
      try {
        if (replied) {
          await client.call("ota.asset_range_chunk", {
            requestId,
            partIndex: failurePartIndex,
            offset: failureOffset,
            bytes: Buffer.alloc(0),
            last: true,
          });
        } else {
          await client.call("ota.asset_range_rejected", {
            requestId,
            reason: message,
          });
        }
      } catch (replyError) {
        log.warn(`Failed to terminate OTA range ${requestId}: ${errorMessage(replyError)}`);
      }
    } finally {
      if (this.carThingRangeTasks.get(requestId) === controller) {
        this.carThingRangeTasks.delete(requestId);
      }
    }
  }

  private resumePreparedCarThingOta(
    connectionID: string,
    allowActiveInstall = false,
  ): Promise<void> {
    if (this.carThingInstallPromise && !allowActiveInstall) {
      return Promise.resolve();
    }
    if (!this.activeCarThingUpdate) return Promise.resolve();
    if (this.carThingResumePromise) return this.carThingResumePromise;

    const resume = this.performPreparedCarThingOtaResume(connectionID)
      .finally(() => {
        if (this.carThingResumePromise === resume) {
          this.carThingResumePromise = null;
        }
      });
    this.carThingResumePromise = resume;
    return resume;
  }

  private async performPreparedCarThingOtaResume(
    connectionID: string,
  ): Promise<void> {
    const connection = this.connections.get(connectionID);
    if (!connection) return;
    const generation = this.carThingOtaGeneration;

    try {
      const update =
        this.activeCarThingUpdate ??
        (await this.carThingOtaService.activeUpdate());
      if (!update) return;
      if (!(await this.carThingOtaService.verifyPreparedUpdate(update))) {
        log.warn(`Discarding incomplete cached OTA ${update.updateId}`);
        await this.carThingOtaService.clearActiveUpdate(true);
        this.activeCarThingUpdate = null;
        return;
      }
      if (
        generation !== this.carThingOtaGeneration ||
        this.connections.get(connectionID) !== connection
      ) return;

      this.activeCarThingUpdate = update;
      const begin = await connection.rpcClient.call("ota.begin", {
        kind: update.kind,
        updateId: update.updateId,
        updateUrlBase: update.updateUrlBase,
        expectedSha256: update.expectedSha256,
        expectedSize: update.expectedSize,
      });
      const resumeFromOffset = integerParam(
        asUnknownRecord(begin)?.resumeFromOffset ??
          asUnknownRecord(begin)?.resume_from_offset,
        0,
      );
      if (
        generation !== this.carThingOtaGeneration ||
        this.connections.get(connectionID) !== connection
      ) return;
      await this.sendCarThingPackageReady(
        connection.rpcClient,
        update,
        resumeFromOffset,
      );
      log.info(`Rebound cached OTA ${update.updateId} after reconnect`);
    } catch (err) {
      log.warn(`Failed to rebind cached Car Thing OTA: ${errorMessage(err)}`);
    }
  }

  private async sendCarThingPackageReady(
    client: RPCClient,
    update: CarThingAvailableUpdate,
    resumeFromOffset: number,
  ): Promise<void> {
    await client.sendEvent("ota.package_ready", {
      updateId: update.updateId,
      version: update.version,
      size: update.expectedSize,
      expectedSha256: update.expectedSha256,
      resumeFromOffset,
      maxTransferChunkSize: MAX_OTA_TRANSFER_WINDOW_BYTES,
      supportsChunkedTransferResponse: true,
      transferDataEncoding: "msgpack_binary",
    });
  }

  private async sendCarThingCheckResult(
    client: RPCClient,
    update: CarThingAvailableUpdate | null,
    channel: string,
  ): Promise<void> {
    await client.sendEvent("ota.check_result", {
      available: update !== null,
      version: update?.version ?? null,
      kind: update?.kind ?? null,
      channel,
      requiresReflash: update?.requiresReflash ?? false,
      flashthingZipUrl: update?.flashthingZipUrl ?? null,
    });
  }

  private carThingOtaVersions(
    params: CarThingOtaRequestParams,
  ): CarThingOtaVersionLanes | null {
    for (const connection of this.connections.values()) {
      const versions = carThingOtaRequestVersions(
        params,
        connection.deviceInfo,
      );
      if (versions) return versions;
    }
    return carThingOtaRequestVersions(params, null);
  }

  onError(error: Error): void {
    log.error(`RPC error: ${error.message}`);
  }

  onDisconnect(): void {
    log.info("RPC client disconnected");
  }

  onPlayerEvent(event: any): void {
    const { cleanupWebSocketMessage } = require("./services/spotify-filters");
    const result = cleanupWebSocketMessage(event);
    if (!result) return;

    this.enrichTrackMetadata(result.data)
      .then(() => {
        this.cachePlayerState(result.data);
        this.broadcastToDevices(result.topic, result.data);
        this.broadcastToWebSocket(result.topic, result.data);
      })
      .catch(() => {
        this.cachePlayerState(result.data);
        this.broadcastToDevices(result.topic, result.data);
        this.broadcastToWebSocket(result.topic, result.data);
      });
  }

  private cachePlayerState(data: any): void {
    const cluster = data?.payloads?.[0]?.cluster;
    if (cluster?.player_state) {
      this.cachedPlayerState = cluster;
    }
    const activeDeviceId = cluster?.active_device_id;
    if (activeDeviceId) {
      this.spotifyService.setActiveDeviceId(activeDeviceId);
    }
  }

  private async enrichTrackMetadata(data: any): Promise<void> {
    const playerState = data?.payloads?.[0]?.cluster?.player_state;
    const track = playerState?.track;
    if (!playerState || !track?.uri) return;

    track.metadata = track.metadata ?? {};
    const uri: string = track.uri;
    let hasArtists = Array.isArray(track.metadata.artists) && track.metadata.artists.length > 0;

    if (uri.startsWith("spotify:track:")) {
      const trackId = uri.slice("spotify:track:".length);
      const info = await this.spotifyService.fetchTrackInfo(trackId);
      if (info) {
        this.spotifyService.mergeTrackInfoIntoPlayerState(playerState, info);
        hasArtists = Array.isArray(track.metadata.artists) && track.metadata.artists.length > 0;
      }
    } else if (uri.startsWith("spotify:local:")) {
      const parts = uri.split(":");
      if (parts.length >= 5 && (!Array.isArray(track.metadata.artists) || track.metadata.artists.length === 0)) {
        const decoded = decodeURIComponent(parts[2]).replace(/\+/g, " ");
        const names = decoded.split(",").map((n) => n.trim()).filter(Boolean);
        track.metadata.artists = names.map((name) => ({
          id: "",
          name,
          uri: "",
          type: "artist",
        }));
        hasArtists = track.metadata.artists.length > 0;
      }
    }

    const albumUri = track.metadata.album_uri;
    if (!hasArtists && typeof albumUri === "string" && albumUri.startsWith("spotify:album:")) {
      const albumId = albumUri.slice("spotify:album:".length);
      const artists = await this.spotifyService.fetchAlbumArtists(albumId);
      if (artists.length > 0) {
        track.metadata.artists = artists;
      }
    }
  }

  onConnectionStateChange(connected: boolean): void {
    this.broadcastToWebSocket("spotify.websocket.status", { connected });
  }

  getConnectionStatus(): { connected: boolean; deviceCount: number; devices: any[] } {
    const devices = Array.from(this.connections.entries()).map(([id, conn]) => ({
      id,
      deviceInfo: conn.deviceInfo,
    }));
    return {
      connected: this.connections.size > 0,
      deviceCount: this.connections.size,
      devices,
    };
  }
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function integerParam(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}

function otaKindParam(value: string | null): CarThingOtaKind | null {
  return value === "image" ||
    value === "daemon" ||
    value === "builtinWebapp" ||
    value === "bandaid"
    ? value
    : null;
}

export function carThingOtaRequestParams(
  data: unknown,
): CarThingOtaRequestParams {
  const params = asUnknownRecord(data);
  return {
    currentVersion:
      stringParam(params?.currentVersion) ??
      stringParam(params?.current_version),
    imageVersion:
      stringParam(params?.imageVersion) ?? stringParam(params?.image_version),
    bandaidVersion:
      stringParam(params?.bandaidVersion) ??
      stringParam(params?.bandaid_version),
    channel: stringParam(params?.channel) ?? "stable",
    targetVersion:
      stringParam(params?.targetVersion) ?? stringParam(params?.target_version),
    targetKind: otaKindParam(
      stringParam(params?.targetKind) ?? stringParam(params?.target_kind),
    ),
  };
}

export function normalizeDeviceInfo(data: unknown): DeviceInfo {
  const info = asUnknownRecord(data);
  return {
    device: stringParam(info?.device) ?? "Nocturne Car Thing",
    version: stringParam(info?.version) ?? "",
    fullVersion:
      stringParam(info?.fullVersion) ?? stringParam(info?.full_version),
    imageVersion:
      stringParam(info?.imageVersion) ?? stringParam(info?.image_version),
    bandaidVersion:
      stringParam(info?.bandaidVersion) ?? stringParam(info?.bandaid_version),
    buildDate: stringParam(info?.buildDate) ?? stringParam(info?.build_date),
    gitHash: stringParam(info?.gitHash) ?? stringParam(info?.git_hash),
    serialNumber:
      stringParam(info?.serialNumber) ?? stringParam(info?.serial_number),
  };
}

export function carThingOtaRequestVersions(
  params: CarThingOtaRequestParams,
  deviceInfo: unknown,
): CarThingOtaVersionLanes | null {
  const info = asUnknownRecord(deviceInfo);
  return carThingOtaVersionLanes(
    params.currentVersion ?? stringParam(info?.version),
    params.imageVersion ??
      stringParam(info?.imageVersion) ??
      stringParam(info?.image_version),
    params.bandaidVersion ??
      stringParam(info?.bandaidVersion) ??
      stringParam(info?.bandaid_version),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRanges(
  value: unknown,
  asset: CarThingOtaAsset,
): Array<{ start: number; length: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("OTA range request has no ranges");
  }
  return value.map((item, index) => {
    const range = asUnknownRecord(item);
    const start = integerParam(range?.start, -1);
    const length = integerParam(range?.length, -1);
    if (start < 0 || length <= 0 || start + length > asset.size) {
      throw new Error(`Invalid OTA range ${index} for ${asset.name}`);
    }
    return { start, length };
  });
}
