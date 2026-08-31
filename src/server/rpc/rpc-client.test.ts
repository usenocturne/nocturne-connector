import { describe, expect, test } from "bun:test";
import { parseChunk } from "./chunking";
import { decode, encode } from "./msgpack-codec";
import type { RPCCallMessage } from "./protocol";
import { RPCClient } from "./rpc-client";

const CALL_ID = "00000000-0000-4000-8000-000000000001";

class FakeSocket {
  readonly writes: Buffer[] = [];

  async write(data: Buffer | Uint8Array): Promise<void> {
    this.writes.push(Buffer.from(data));
  }

  end(): void {}
}

function encodedCall(method: string, params: unknown): Buffer {
  const call: RPCCallMessage = {
    type: "call",
    id: CALL_ID,
    method,
    params,
  };
  return Buffer.from(`${encode(call).toString("base64")}\n`);
}

function setTransferDelegate(client: RPCClient): void {
  client.setDelegate({
    async onCall() {
      return { result: { data: Buffer.alloc(4_000, 7) } };
    },
    onEvent() {},
    onError() {},
    onDisconnect() {},
  });
}

describe("RPCClient", () => {
  test("keeps legacy OTA transfer responses in base64-newline format", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline");
    client.setSocket(socket);
    setTransferDelegate(client);

    await client.handleIncomingData(encodedCall("device.ota.transfer", {
      offset: 0,
      size: 4_000,
    }));

    expect(socket.writes.length).toBeGreaterThan(1);
    for (const write of socket.writes) {
      expect(write.at(-1)).toBe(0x0a);
      expect(parseChunk(Buffer.from(write.toString().trim(), "base64")).status)
        .toBe("success");
    }
    client.cleanup();
  });

  test("keeps capable OTA checksum envelopes inside the SPP base64 transport", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline", {
      preserveConnectionWireFormat: true,
    });
    client.setSocket(socket);
    setTransferDelegate(client);

    await client.handleIncomingData(encodedCall("device.ota.transfer", {
      offset: 0,
      size: 4_000,
      transport_capabilities: {
        raw_checksum_envelopes: true,
      },
    }));

    const payloads: Buffer[] = [];
    for (const write of socket.writes) {
      expect(write.at(-1)).toBe(0x0a);
      const parsed = parseChunk(Buffer.from(write.toString().trim(), "base64"));
      if (parsed.status !== "success") {
        throw new Error("expected a base64-wrapped checksum envelope");
      }
      payloads.push(parsed.payload);
    }
    const result = decode(Buffer.concat(payloads));
    expect(result).toMatchObject({
      type: "result",
      id: CALL_ID,
    });
    if (
      result.type !== "result" ||
      typeof result.result !== "object" ||
      result.result === null
    ) {
      throw new Error("expected a result payload");
    }
    const binary = Reflect.get(result.result, "data");
    if (!(binary instanceof Uint8Array)) {
      throw new Error("expected MessagePack binary transfer data");
    }
    expect(Buffer.from(binary)).toEqual(Buffer.alloc(4_000, 7));

    const originalLine = socket.writes[0];
    if (!originalLine) throw new Error("expected checksum envelope");
    const first = parseChunk(Buffer.from(originalLine.toString().trim(), "base64"));
    if (first.status !== "success") throw new Error("expected valid chunk");
    socket.writes.length = 0;
    await client.retransmitChunk(first.envelope.messageId, first.envelope.index);
    expect(socket.writes).toEqual([originalLine]);
    client.cleanup();
  });

  test("accepts camel-case raw checksum envelope capability", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline", {
      preserveConnectionWireFormat: true,
    });
    client.setSocket(socket);
    setTransferDelegate(client);

    await client.handleIncomingData(encodedCall("device.ota.transfer", {
      offset: 0,
      size: 4_000,
      transportCapabilities: {
        rawChecksumEnvelopes: true,
      },
    }));

    expect(socket.writes.length).toBeGreaterThan(1);
    expect(socket.writes.every((write) => {
      if (write.at(-1) !== 0x0a) return false;
      return parseChunk(Buffer.from(write.toString().trim(), "base64")).status === "success";
    })).toBe(true);
    client.cleanup();
  });

  test("preserves the Pi raw-envelope response override", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline", {
      preserveConnectionWireFormat: false,
    });
    client.setSocket(socket);
    setTransferDelegate(client);

    await client.handleIncomingData(encodedCall("device.ota.transfer", {
      offset: 0,
      size: 4_000,
      transport_capabilities: {
        raw_checksum_envelopes: true,
      },
    }));

    expect(socket.writes.length).toBeGreaterThan(1);
    expect(socket.writes.every((write) => write.at(-1) !== 0x0a)).toBe(true);
    expect(socket.writes.every((write) => parseChunk(write).status === "success"))
      .toBe(true);
    client.cleanup();
  });

  test("retransmits base64-newline chunks in the negotiated wire format", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline");
    client.setSocket(socket);

    await client.sendEvent("test.event", { bytes: Buffer.alloc(4_000, 7) });
    const originalLine = socket.writes[0];
    if (!originalLine) throw new Error("expected framed write");
    const originalChunk = Buffer.from(originalLine.toString().trim(), "base64");
    const parsed = parseChunk(originalChunk);
    if (parsed.status !== "success") throw new Error("expected valid chunk");

    socket.writes.length = 0;
    await client.retransmitChunk(parsed.envelope.messageId, parsed.envelope.index);

    expect(socket.writes).toHaveLength(1);
    expect(socket.writes[0]).toEqual(originalLine);
    client.cleanup();
  });

  test("rejects writes after the socket has closed", async () => {
    const client = new RPCClient("test");
    await expect(client.sendEvent("test.event", {})).rejects.toThrow(
      "closed connection",
    );
    client.cleanup();
  });

  test("keeps the event loop responsive and lets control traffic preempt delayed bulk writes", async () => {
    const writes: Buffer[] = [];
    const client = new RPCClient("test");
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let bulkComplete = false;
    let timerObservedBulkPending = false;
    let normalSend: Promise<void> | undefined;
    client.setSocket({
      async write(data) {
        writes.push(Buffer.from(data));
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWrites--;
      },
      end() {},
    });

    const bulkSend = client
      .sendEvent("ota.chunk", { bytes: Buffer.alloc(8_000, 7) })
      .then(() => {
        bulkComplete = true;
      });
    setTimeout(() => {
      timerObservedBulkPending = !bulkComplete;
      normalSend = client.sendEvent("control.event", { ready: true });
    }, 0);

    await bulkSend;
    await normalSend;

    expect(timerObservedBulkPending).toBe(true);
    expect(maxActiveWrites).toBe(1);
    expect(writes.length).toBeGreaterThan(2);
    const second = writes[1];
    if (!second) throw new Error("expected normal-priority write");
    const parsed = parseChunk(second);
    if (parsed.status !== "success") throw new Error("expected valid chunk");
    expect(decode(parsed.payload)).toMatchObject({
      type: "event",
      topic: "control.event",
    });
    client.cleanup();
  });

  test("lets control traffic preempt multi-frame media artwork", async () => {
    const writes: Buffer[] = [];
    const client = new RPCClient("test");
    let markFirstWriteStarted = () => {};
    let releaseFirstWrite = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    client.setSocket({
      async write(data) {
        writes.push(Buffer.from(data));
        if (writes.length === 1) {
          markFirstWriteStarted();
          await firstWriteGate;
        }
      },
      end() {},
    });

    const artworkSend = client.sendEvent("media.now_playing.artwork", {
      data: Buffer.alloc(8_000, 7).toString("base64"),
      content_type: "image/jpeg",
      media_generation: 12,
    });
    await firstWriteStarted;
    const controlSend = client.sendEvent("media.control.state", { ready: true });
    releaseFirstWrite();

    await Promise.all([artworkSend, controlSend]);

    expect(writes.length).toBeGreaterThan(2);
    const second = writes[1];
    if (!second) throw new Error("expected normal-priority write");
    const parsed = parseChunk(second);
    if (parsed.status !== "success") throw new Error("expected valid chunk");
    expect(decode(parsed.payload)).toMatchObject({
      type: "event",
      topic: "media.control.state",
    });
    client.cleanup();
  });
});
