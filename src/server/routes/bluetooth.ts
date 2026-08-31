import { Elysia } from "elysia";
import {
  bluetoothDisplayName,
  type BluetoothService,
} from "../services/bluetooth-service";

export function createBluetoothRoutes(bt: BluetoothService) {
  const routes = new Elysia({ prefix: "/api/bluetooth" })
    .get("/status", async () => bt.getStatus())
    .post("/power", async ({ body }) => {
      const { on } = body as { on: boolean };
      if (on) await bt.powerOn();
      else await bt.powerOff();
      return { success: true };
    })
    .get("/devices", async () => {
      const devices = await bt.getDevices();
      return { devices };
    })
    .post("/scan", async () => {
      await bt.startScan();
      return { success: true };
    })
    .post("/stop-scan", async () => {
      await bt.stopScan();
      return { success: true };
    })
    .post("/pair/:address", async ({ params }) => {
      await bt.pair(params.address);
      return { success: true };
    })
    .post("/connect/:address", async ({ params, query }) => {
      const channel = query?.channel ? Number(query.channel) : undefined;
      await bt.connect(params.address, channel);
      return { success: true };
    })
    .post("/unpair/:address", async ({ params }) => {
      await bt.unpair(params.address);
      return { success: true };
    })
    .post("/trust/:address", async ({ params }) => {
      await bt.trust(params.address);
      return { success: true };
    })
    .get("/pairing-request", () => {
      const pin = bt.pendingPairingPin;
      return { pending: !!pin, request: pin };
    })
    .post("/pairing-confirm", () => {
      bt.confirmPairing();
      return { success: true };
    })
    .post("/pairing-reject", () => {
      bt.rejectPairing();
      return { success: true };
    })
    .get("/connections", () => bluetoothConnectionsResponse(bt));

  if (!bt.usesWindowsRouteSemantics) return routes;
  return routes.post("/disconnect/:address", async ({ params }) => {
    await bt.disconnect(params.address);
    return { success: true };
  });
}

export async function bluetoothConnectionsResponse(
  bt: Pick<
    BluetoothService,
    "getConnections" | "getDevices" | "usesWindowsRouteSemantics"
  >,
): Promise<{
  connections: Array<{
    devicePath: string;
    address: string;
    name?: string;
  }>;
}> {
  const conns = bt.getConnections();
  if (!bt.usesWindowsRouteSemantics) {
    return {
      connections: Array.from(conns.entries()).map(([path, connection]) => ({
        devicePath: path,
        address: connection.address,
      })),
    };
  }
  const devices = await bt.getDevices();
  const names = new Map(
    devices.map((device) => [device.address.toUpperCase(), device.name]),
  );
  const connections = new Map<string, {
    devicePath: string;
    address: string;
    name: string;
  }>();
  for (const [devicePath, connection] of conns) {
    const key = connection.address.toUpperCase();
    if (connections.has(key)) continue;
    connections.set(key, {
      devicePath,
      address: connection.address,
      name: bluetoothDisplayName(names.get(key) ?? "", connection.address),
    });
  }
  return {
    connections: Array.from(connections.values()),
  };
}
