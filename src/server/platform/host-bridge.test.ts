import { afterEach, describe, expect, test } from "bun:test";
import { decode, encode } from "@msgpack/msgpack";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server, type Socket } from "node:net";
import { HostBridge, HostBridgeError } from "./host-bridge";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const bridges: HostBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("HostBridge", () => {
  test("frames authenticated requests and resolves MessagePack responses", async () => {
    const harness = await createHarness((message, socket) => {
      expect(message).toEqual({
        type: "request",
        id: 1,
        token: "secret",
        generation: 1,
        method: "bluetooth.get_status",
        params: {},
      });
      socket.write(frame({ type: "response", id: 1, generation: 1, result: { powered: true } }));
    });
    const bridge = new HostBridge(harness.path, "secret");
    bridges.push(bridge);

    await expect(bridge.call("bluetooth.get_status")).resolves.toEqual({ powered: true });
  });

  test("preserves MessagePack binary event payloads", async () => {
    let resolvePeer: (socket: Socket) => void = () => undefined;
    const peerPromise = new Promise<Socket>((resolve) => {
      resolvePeer = resolve;
    });
    const harness = await createHarness((_message, socket) => {
      resolvePeer(socket);
      socket.write(frame({ type: "response", id: 1, generation: 1, result: {} }));
    });
    const bridge = new HostBridge(harness.path, "secret");
    bridges.push(bridge);
    const event = new Promise<Uint8Array>((resolve) => {
      bridge.onEvent<{ data: Uint8Array }>("rfcomm.client.data", (data) => resolve(data.data));
    });
    await bridge.call("bluetooth.initialize");
    const peer = await peerPromise;
    peer.write(
      frame({
        type: "event",
        generation: 1,
        topic: "rfcomm.client.data",
        data: { data: Uint8Array.from([0, 1, 2, 255]) },
      }),
    );

    expect(Array.from(await event)).toEqual([0, 1, 2, 255]);
  });

  test("surfaces structured host errors", async () => {
    const harness = await createHarness((_message, socket) => {
      socket.write(
        frame({
          type: "response",
          id: 1,
          generation: 1,
          error: { code: "unauthorized", message: "Invalid host token" },
        }),
      );
    });
    const bridge = new HostBridge(harness.path, "wrong");
    bridges.push(bridge);

    try {
      await bridge.call("bluetooth.initialize");
      throw new Error("Expected host call to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HostBridgeError);
      expect((error as HostBridgeError).code).toBe("unauthorized");
      expect((error as Error).message).toBe("Invalid host token");
    }
  });

  test("resets a blocked connection without permanently closing the bridge", async () => {
    const harness = await createHarness(() => undefined);
    const bridge = new HostBridge(harness.path, "secret");
    bridges.push(bridge);

    const pending = bridge.call("rfcomm.client.write", { data: [1, 2, 3] });
    await Bun.sleep(5);
    bridge.resetConnection();

    await expect(pending).rejects.toMatchObject({
      name: "HostBridgeError",
      code: "reset",
    });
  });

  test("sends priority control calls over a dedicated connection", async () => {
    const harness = await createHarness((message, socket) => {
      const request = message as { id: number; generation: number; method: string };
      if (request.method === "rfcomm.client.disconnect") {
        socket.write(
          frame({
            type: "response",
            id: request.id,
            generation: request.generation,
            result: { status: "ok" },
          }),
        );
      }
    });
    const bridge = new HostBridge(harness.path, "secret");
    bridges.push(bridge);
    const blocked = bridge.call("rfcomm.client.write", { data: [1, 2, 3] });
    await Bun.sleep(5);

    await expect(
      bridge.call("rfcomm.client.disconnect", {}, { priority: true, timeoutMs: 1_000 }),
    ).resolves.toEqual({ status: "ok" });
    bridge.resetConnection();
    await expect(blocked).rejects.toBeInstanceOf(HostBridgeError);
  });
});

async function createHarness(
  onMessage: (message: unknown, socket: Socket) => void,
): Promise<{ path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "nocturne-host-bridge-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "bridge.sock");
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        onMessage(decode(payload), socket);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { path };
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(encode(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
