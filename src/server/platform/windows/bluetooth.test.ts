import { describe, expect, test } from "bun:test";
import {
  BluetoothService,
  selectWindowsConnectorTarget,
} from "../../services/bluetooth-service";
import type { HostBridgeCallOptions, HostBridgeClient } from "../host-bridge";
import type { PairingPinEvent } from "../../bluetooth/pairing-agent";
import {
  WindowsBluetoothAdapter,
  WindowsPairingAgent,
  WindowsRFCOMMClient,
  WindowsRFCOMMServer,
} from "./bluetooth";

class FakeHostBridge implements HostBridgeClient {
  readonly calls: { method: string; params: unknown }[] = [];
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  responses = new Map<string, unknown>();

  async call<TResult = unknown>(
    method: string,
    params: unknown = {},
    _options?: HostBridgeCallOptions,
  ): Promise<TResult> {
    this.calls.push({ method, params });
    return this.responses.get(method) as TResult;
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

function createService(bridge: FakeHostBridge): BluetoothService {
  return new BluetoothService({
    platform: "win32",
    adapter: new WindowsBluetoothAdapter(bridge),
    rfcommServer: new WindowsRFCOMMServer(bridge),
    rfcommClient: new WindowsRFCOMMClient(bridge),
    pairingAgent: new WindowsPairingAgent(bridge),
  });
}

describe("Windows Bluetooth host adapters", () => {
  test("initializes the native host and registers the Pi and probe channels", async () => {
    const bridge = new FakeHostBridge();
    const service = createService(bridge);
    await service.initialize();

    expect(bridge.calls).toContainEqual({ method: "bluetooth.initialize", params: {} });
    expect(bridge.calls).not.toContainEqual({
      method: "bluetooth.set_discoverable",
      params: { enabled: true },
    });
    expect(bridge.calls).not.toContainEqual({
      method: "bluetooth.set_discoverable",
      params: { enabled: false },
    });
    expect(bridge.calls).toContainEqual({
      method: "bluetooth.set_pairable",
      params: { enabled: true },
    });
    expect(bridge.calls).not.toContainEqual({
      method: "bluetooth.start_discovery",
      params: {},
    });
    expect(bridge.calls).toContainEqual({
      method: "rfcomm.server.register",
      params: {
        serviceUuid: "00001101-0000-1000-8000-00805f9b34fb",
        channel: 1,
        probeChannel: 3,
      },
    });
  });

  test("maps native discovery and adapter status to the existing service contract", async () => {
    const bridge = new FakeHostBridge();
    bridge.responses.set("bluetooth.get_status", {
      powered: true,
      discovering: false,
      address: "00:11:22:33:44:55",
    });
    bridge.responses.set("bluetooth.get_devices", {
      devices: [
        {
          address: "30:E3:D6:00:B5:5F",
          name: "Nocturne",
          paired: true,
          connected: false,
          trusted: true,
          rssi: -42,
          icon: "computer",
        },
      ],
    });
    const service = createService(bridge);
    await service.initialize();

    await expect(service.getStatus()).resolves.toEqual({
      powered: true,
      discovering: false,
      address: "00:11:22:33:44:55",
    });
    await expect(service.getDevices()).resolves.toHaveLength(1);

    const events: { event: string; data: unknown }[] = [];
    service.onEvent((event, data) => events.push({ event, data }));
    bridge.emit("bluetooth.adapter_status", {
      powered: false,
      discovering: false,
      address: "",
    });
    expect(events).toContainEqual({
      event: "adapterStatus",
      data: { powered: false, discovering: false, address: "" },
    });
  });

  test("promotes autonomous native channel-2 connections into device events", async () => {
    const bridge = new FakeHostBridge();
    const service = createService(bridge);
    const events: { event: string; data: unknown }[] = [];
    service.onEvent((event, data) => events.push({ event, data }));
    await service.initialize();

    bridge.emit("rfcomm.client.connected", { address: "30:E3:D6:00:B5:5F" });

    expect(events).toContainEqual({
      event: "deviceConnected",
      data: {
        address: "30:E3:D6:00:B5:5F",
        devicePath: "rfcomm-client:30:E3:D6:00:B5:5F",
      },
    });
  });

  test("keeps RFCOMM payloads binary across the native bridge", async () => {
    const bridge = new FakeHostBridge();
    const client = new WindowsRFCOMMClient(bridge);
    let received: number[] = [];
    client.setDataHandler((data) => {
      received = Array.from(data);
    });

    bridge.emit("rfcomm.client.data", { data: Uint8Array.from([0, 1, 255]) });

    expect(received).toEqual([0, 1, 255]);
  });

  test("encodes outbound RFCOMM bytes as bridge-safe numeric arrays", async () => {
    const bridge = new FakeHostBridge();
    const client = new WindowsRFCOMMClient(bridge);
    await client.connect("30:E3:D6:00:B5:5F");

    await client.write(Uint8Array.from([0, 1, 255]));

    expect(bridge.calls).toContainEqual({
      method: "rfcomm.client.write",
      params: { data: [0, 1, 255] },
    });
  });

  test("does not duplicate a manual connection when the native event is echoed", async () => {
    const bridge = new FakeHostBridge();
    const client = new WindowsRFCOMMClient(bridge);
    let connectionEvents = 0;
    client.setConnectionHandler(() => {
      connectionEvents++;
    });

    await client.connect("30:E3:D6:00:B5:5F");
    bridge.emit("rfcomm.client.connected", { address: "30:E3:D6:00:B5:5F" });

    expect(connectionEvents).toBe(1);
  });

  test("disconnects an inbound native route by Bluetooth address", async () => {
    const bridge = new FakeHostBridge();
    const server = new WindowsRFCOMMServer(bridge);
    let disconnectedPath = "";
    let disconnectionEvents = 0;
    server.setConnectionHandler(() => {});
    server.setDisconnectionHandler((devicePath) => {
      disconnectedPath = devicePath;
      disconnectionEvents++;
    });
    server.setDataHandler(() => {});
    await server.register();
    bridge.emit("rfcomm.server.connected", {
      address: "30:E3:D6:00:B5:5F",
      connectionId: "route-1",
    });

    await expect(server.disconnectDevice("30:e3:d6:00:b5:5f")).resolves.toBeTrue();
    expect(bridge.calls).toContainEqual({
      method: "rfcomm.server.disconnect",
      params: { connectionId: "route-1" },
    });
    expect(disconnectedPath).toBe("rfcomm-server:route-1");
    bridge.emit("rfcomm.server.disconnected", {
      address: "30:E3:D6:00:B5:5F",
      connectionId: "route-1",
    });
    expect(disconnectionEvents).toBe(1);
  });

  test("round-trips native PIN confirmation through the shared pairing agent", async () => {
    const bridge = new FakeHostBridge();
    const agent = new WindowsPairingAgent(bridge);
    let displayedPin = "";
    agent.setOnPinDisplay((event) => {
      displayedPin = event.pin;
    });
    await agent.register();

    bridge.emit("bluetooth.pairing_request", {
      address: "30:E3:D6:00:B5:5F",
      name: "Nocturne (Q01S)",
      pin: "042819",
      requestId: "request-1",
    });
    expect(agent.pendingPin).toEqual({
      address: "30:E3:D6:00:B5:5F",
      name: "Nocturne (Q01S)",
      pin: "042819",
      requestId: "request-1",
      type: "bluetooth_pin",
      confirmationRequired: true,
    });
    expect(displayedPin).toBe("042819");

    await agent.confirmPairing("request-1");
    await Bun.sleep(0);
    expect(bridge.calls).toContainEqual({
      method: "bluetooth.pairing.confirm",
      params: { requestId: "request-1" },
    });
  });

  test("requires the current request and propagates bridge failures", async () => {
    const bridge = new FakeHostBridge();
    const agent = new WindowsPairingAgent(bridge);
    await agent.register();
    bridge.emit("bluetooth.pairing_request", {
      address: "30:E3:D6:00:B5:5F", pin: "123456", requestId: "entry-1",
    });
    await expect(agent.confirmPairing("stale")).rejects.toThrow("expired");
    expect(bridge.calls).toHaveLength(0);
    bridge.emit("bluetooth.pairing_cancelled", { requestId: "stale" });
    expect(agent.pendingPin?.requestId).toBe("entry-1");
    await agent.confirmPairing("entry-1");
    expect(bridge.calls).toContainEqual({ method: "bluetooth.pairing.confirm", params: { requestId: "entry-1" } });
    expect(agent.pendingPin).toBeNull();
    bridge.emit("bluetooth.pairing_request", { address: "30:E3:D6:00:B5:5F", pin: "123456", requestId: "entry-2" });
    bridge.call = async () => { throw new Error("native unavailable"); };
    await expect(agent.rejectPairing("entry-2")).rejects.toThrow("native unavailable");
    expect(agent.pendingPin?.requestId).toBe("entry-2");
  });

  test("ignores unsupported PIN ceremonies and propagates native pairing failures", async () => {
    const bridge = new FakeHostBridge();
    const agent = new WindowsPairingAgent(bridge);
    let displayed: PairingPinEvent | null = null;
    let pairingError: string | undefined;
    agent.setOnPinDisplay((event) => {
      displayed = event;
    });
    agent.setOnPairingCancelled((error) => {
      pairingError = error;
    });
    await agent.register();

    bridge.emit("bluetooth.pairing_request", {
      address: "30:E3:D6:00:B5:5F",
      name: "Nocturne (Q01S)",
      pin: "0000",
      confirmationRequired: false,
    });
    expect(displayed).toBeNull();
    expect(agent.pendingPin).toBeNull();

    bridge.emit("bluetooth.pairing_cancelled", {
      address: "30:E3:D6:00:B5:5F",
      error: "Windows mutual authentication failed",
    });
    expect(pairingError).toBe("Windows mutual authentication failed");
    expect(agent.pendingPin).toBeNull();
  });

  test("selects only a paired Nocturne device for Windows recovery", () => {
    const device = {
      address: "30:E3:D6:00:B5:5F",
      name: "Nocturne (Q01S)",
      paired: true,
      connected: true,
      trusted: true,
      rssi: -100,
      icon: "computer",
    };
    expect(
      selectWindowsConnectorTarget([
        { ...device, address: "AA:BB:CC:DD:EE:FF", name: "iPhone" },
        device,
      ]),
    ).toEqual(device);
    expect(selectWindowsConnectorTarget([{ ...device, paired: false }])).toBeUndefined();
  });
});
