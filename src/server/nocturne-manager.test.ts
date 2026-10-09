import { describe, expect, test } from "bun:test";
import {
  carThingOtaRequestParams,
  carThingOtaRequestVersions,
  deviceTimeResponse,
  normalizeDeviceInfo,
} from "./nocturne-manager";

// Capability and metadata tests never use native Bluetooth hardware.
const fakeBluetoothService: any = {
  initialize: async () => {},
  rfcommServer: { setDataHandler: () => {} },
  rfcommOutbound: { setDataHandler: () => {} },
  onEvent: () => {},
};

describe("device info", () => {
  test("normalizes the daemon's canonical snake-case response", () => {
    expect(
      normalizeDeviceInfo({
        device: "Nocturne (Q01S)",
        version: "4.1.2",
        full_version: "4.1.2+20260803231914",
        image_version: "4.1.1",
        bandaid_version: "4.1.2",
        build_date: "2026-08-03T23:19:30Z",
        git_hash: "abc123",
        serial_number: "8555RO80Q01S",
      }),
    ).toEqual({
      device: "Nocturne (Q01S)",
      version: "4.1.2",
      fullVersion: "4.1.2+20260803231914",
      imageVersion: "4.1.1",
      bandaidVersion: "4.1.2",
      buildDate: "2026-08-03T23:19:30Z",
      gitHash: "abc123",
      serialNumber: "8555RO80Q01S",
    });
  });

  test("keeps compatibility with camel-case responses", () => {
    expect(
      normalizeDeviceInfo({
        device: "Nocturne",
        version: "4.1.2",
        imageVersion: "4.1.1",
        serialNumber: "SERIAL",
      }),
    ).toMatchObject({
      imageVersion: "4.1.1",
      serialNumber: "SERIAL",
    });
  });
});

describe("sendAppReady", () => {
  test("includes connectorPlatform: 'windows' on win32 while keeping platform: 'web'", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const manager = new NocturneManager({ platform: "win32", bluetoothService: fakeBluetoothService });

    let broadcastTopic = "";
    let broadcastData: any = null;
    (manager as any).broadcastToDevices = async (topic: string, data: any) => {
      if (topic === "app.ready") {
        broadcastTopic = topic;
        broadcastData = data;
      }
    };

    await (manager as any).sendAppReady();

    expect(broadcastTopic).toBe("app.ready");
    expect(broadcastData).toMatchObject({
      platform: "web",
      connectorPlatform: "windows",
      capabilities: {
        volume: false,
        media: false,
        discord: false,
        systemStats: false,
        macros: false,
        appLaunch: false,
      },
    });
    expect(typeof broadcastData.timestamp).toBe("number");
    expect(typeof broadcastData.datetime).toBe("string");
    expect(typeof broadcastData.time).toBe("string");
    expect(typeof broadcastData.timezone).toBe("object");
  });

  test("does not include connectorPlatform on non-Windows platforms (e.g. linux)", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const manager = new NocturneManager({ platform: "linux", bluetoothService: fakeBluetoothService });

    let broadcastData: any = null;
    (manager as any).broadcastToDevices = async (topic: string, data: any) => {
      if (topic === "app.ready") {
        broadcastData = data;
      }
    };

    await (manager as any).sendAppReady();

    expect(broadcastData).toMatchObject({
      platform: "web",
    });
    expect(broadcastData.connectorPlatform).toBeUndefined();
  });
});

describe("capabilities", () => {
  test("returns false for volume and media when systemMediaService is null", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const manager = new NocturneManager({ platform: "linux", bluetoothService: fakeBluetoothService });
    expect(manager.getCapabilities()).toEqual({
      volume: false,
      media: false,
      discord: false,
      systemStats: false,
      macros: false,
      appLaunch: false,
    });
  });

  test("media capability reflects active state while volume remains available independently", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const mockHostBridge: any = {
      call: async () => ({ status: "ok", volume_percent: 50, muted: false }),
      onEvent: () => () => {},
      close: () => {},
    };
    const memoryStore: any = {
      enabled: true,
      load() { return this.enabled; },
      save(enabled: boolean) { this.enabled = enabled; },
    };
    const manager = new NocturneManager({
      platform: "win32",
      hostBridge: mockHostBridge,
      bluetoothService: fakeBluetoothService,
      systemMediaPreferenceStore: memoryStore,
    });

    // Before start / verification, volume and media are unconfirmed -> volume: false, media: false
    expect(manager.getCapabilities()).toEqual({
      volume: false,
      media: false,
      discord: false,
      systemStats: false,
      macros: false,
      appLaunch: false,
    });

    // After starting system media, volume probe succeeds and media becomes active -> volume: true, media: true
    await manager.systemMediaService?.start();
    await manager.systemMediaService?.whenIdle();
    expect(manager.getCapabilities().volume).toBeTrue();
    expect(manager.getCapabilities().media).toBeTrue();

    let readyPayload: any = null;
    (manager as any).broadcastToDevices = async (topic: string, data: any) => {
      if (topic === "app.ready") readyPayload = data;
    };
    await (manager as any).sendAppReady();
    expect(readyPayload).toMatchObject({
      platform: "web",
      connectorPlatform: "windows",
      capabilities: { volume: true, media: true },
    });
    expect(await manager.onCall("1", "connector.capabilities", {})).toEqual({
      result: { capabilities: readyPayload.capabilities },
    });

    // Disabling system media deactivates media, but volume remains independently available -> media: false, volume: true
    await manager.systemMediaService?.setSystemMediaEnabled(false);
    expect(manager.getCapabilities()).toEqual({
      volume: true,
      media: false,
      discord: false,
      systemStats: false,
      macros: false,
      appLaunch: false,
    });
    await (manager as any).sendAppReady();
    expect(readyPayload.capabilities).toEqual(manager.getCapabilities());
    expect(await manager.onCall("2", "connector.capabilities", {})).toEqual({
      result: { capabilities: readyPayload.capabilities },
    });
    await manager.systemMediaService?.stop();
  });

  test("media capability is false when system media startup fails", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const failingHostBridge: any = {
      call: async (method: string) => {
        if (method === "media.start") throw new Error("Host bridge connection failed");
        return { status: "ok", volume_percent: 50 };
      },
      onEvent: () => () => {},
      close: () => {},
    };
    const manager = new NocturneManager({
      platform: "win32",
      hostBridge: failingHostBridge,
      bluetoothService: fakeBluetoothService,
    });

    await manager.initializeOffline();

    // Since media.start threw during activation, media remains inactive -> media: false
    expect(manager.getCapabilities().media).toBeFalse();
    // Volume remains supported
    expect(manager.getCapabilities().volume).toBeTrue();
  });

  test("volume capability becomes false when volume endpoint is unsupported", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const unsupportedBridge: any = {
      call: async (method: string) => {
        if (method === "volume.get" || method === "media.get_volume") {
          return { status: "unsupported" };
        }
        return { status: "ok" };
      },
      onEvent: () => () => {},
      close: () => {},
    };
    const manager = new NocturneManager({ platform: "win32", hostBridge: unsupportedBridge, bluetoothService: fakeBluetoothService });
    await manager.systemMediaService?.start();

    expect(await manager.systemMediaService?.getVolume()).toBeNull();
    expect(manager.getCapabilities().volume).toBeFalse();
  });

  test("responds to canonical connector.capabilities RPC query matching getCapabilities() and app.ready", async () => {
    const { NocturneManager } = await import("./nocturne-manager");
    const manager = new NocturneManager({ platform: "linux", bluetoothService: fakeBluetoothService });
    const caps = manager.getCapabilities();

    let readyPayload: any = null;
    (manager as any).broadcastToDevices = async (topic: string, data: any) => {
      if (topic === "app.ready") readyPayload = data;
    };
    await (manager as any).sendAppReady();

    expect(readyPayload.capabilities).toEqual(caps);

    const rpcResponse = await manager.onCall("1", "connector.capabilities", {});
    expect(rpcResponse).toEqual({ result: { capabilities: caps } });
  });
});

describe("device time", () => {
  test("reports millisecond Unix time alongside the legacy UTC datetime", () => {
    expect(deviceTimeResponse(new Date(Date.UTC(2026, 9, 4, 0, 36, 55, 789)))).toMatchObject({
      datetime: "2026-10-04 00:36:55",
      timestamp_ms: 1_791_074_215_789,
    });
  });
});

describe("Car Thing OTA request parameters", () => {
  test("parses camel-case version lanes and install target", () => {
    expect(
      carThingOtaRequestParams({
        currentVersion: "4.3.1",
        imageVersion: "4.2.0",
        bandaidVersion: "4.3.1",
        channel: "beta",
        targetVersion: "4.4.0",
        targetKind: "image",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
      channel: "beta",
      targetVersion: "4.4.0",
      targetKind: "image",
    });
  });

  test("parses snake-case lanes and rejects an unknown target kind", () => {
    expect(
      carThingOtaRequestParams({
        current_version: "4.3.1",
        image_version: "4.2.0",
        bandaid_version: "4.3.1",
        target_version: "4.4.0",
        target_kind: "unsupported",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
      channel: "stable",
      targetVersion: "4.4.0",
      targetKind: null,
    });
  });

  test("uses cached snake-case device info when the request has no snapshot", () => {
    const params = carThingOtaRequestParams({ channel: "stable" });

    expect(
      carThingOtaRequestVersions(params, {
        version: "4.3.1",
        image_version: "4.2.0",
        bandaid_version: "4.3.1",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
    });
  });

  test("keeps an explicit request snapshot independent of cached device info", () => {
    const params = carThingOtaRequestParams({
      currentVersion: "4.1.0",
      imageVersion: "4.0.0",
      bandaidVersion: "4.1.0",
    });

    expect(
      carThingOtaRequestVersions(params, {
        version: "5.0.0",
        imageVersion: "5.0.0",
        bandaidVersion: "5.0.0",
      }),
    ).toEqual({
      currentVersion: "4.1.0",
      imageVersion: "4.0.0",
      bandaidVersion: "4.1.0",
    });
  });

  test("fills omitted request lanes from cached device info", () => {
    const params = carThingOtaRequestParams({ currentVersion: "4.3.1" });

    expect(
      carThingOtaRequestVersions(params, {
        version: "4.3.0",
        imageVersion: "4.2.0",
        bandaidVersion: "4.3.1",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
    });
  });

  test("falls missing request and cached lanes back to current", () => {
    const params = carThingOtaRequestParams({ currentVersion: "4.1.0" });

    expect(carThingOtaRequestVersions(params, { version: "4.0.0" })).toEqual({
      currentVersion: "4.1.0",
      imageVersion: "4.1.0",
      bandaidVersion: "4.1.0",
    });
  });
});
