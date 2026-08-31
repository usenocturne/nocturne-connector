import { describe, expect, test } from "bun:test";
import type { RFCOMMConnection } from "../bluetooth/rfcomm-server";
import { bluetoothConnectionsResponse } from "./bluetooth";

function connection(devicePath: string, address: string): RFCOMMConnection {
  return { devicePath, address, fd: -1, stream: null };
}

describe("Bluetooth connection response", () => {
  test("keeps the original Pi shape without enumerating BlueZ devices", async () => {
    let deviceReads = 0;
    const response = await bluetoothConnectionsResponse({
      usesWindowsRouteSemantics: false,
      getConnections: () => new Map([
        ["/org/bluez/hci0/dev_30_E3_D6_00_B5_5F", connection(
          "/org/bluez/hci0/dev_30_E3_D6_00_B5_5F",
          "30:E3:D6:00:B5:5F",
        )],
      ]),
      getDevices: async () => {
        deviceReads++;
        throw new Error("BlueZ enumeration should not run");
      },
    });

    expect(deviceReads).toBe(0);
    expect(response).toEqual({
      connections: [{
        devicePath: "/org/bluez/hci0/dev_30_E3_D6_00_B5_5F",
        address: "30:E3:D6:00:B5:5F",
      }],
    });
  });

  test("adds normalized device names only for Windows", async () => {
    const response = await bluetoothConnectionsResponse({
      usesWindowsRouteSemantics: true,
      getConnections: () => new Map([
        ["rfcomm-client:30:E3:D6:00:B5:5F", connection(
          "rfcomm-client:30:E3:D6:00:B5:5F",
          "30:E3:D6:00:B5:5F",
        )],
      ]),
      getDevices: async () => [{
        address: "30:E3:D6:00:B5:5F",
        name: "Nocturne (Q01S)",
        paired: true,
        connected: true,
        trusted: true,
        rssi: -42,
        icon: "computer",
      }],
    });

    expect(response).toEqual({
      connections: [{
        devicePath: "rfcomm-client:30:E3:D6:00:B5:5F",
        address: "30:E3:D6:00:B5:5F",
        name: "Nocturne (Q01S)",
      }],
    });
  });
});
