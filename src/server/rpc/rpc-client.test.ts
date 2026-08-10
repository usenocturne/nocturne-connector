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

  test("sends capable OTA transfer responses as raw checksum envelopes", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline");
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
      const parsed = parseChunk(write);
      if (parsed.status !== "success") {
        throw new Error("expected raw checksum envelope");
      }
      payloads.push(parsed.payload);
    }
    expect(decode(Buffer.concat(payloads))).toMatchObject({
      type: "result",
      id: CALL_ID,
    });

    const original = socket.writes[0];
    if (!original) throw new Error("expected raw checksum envelope");
    const first = parseChunk(original);
    if (first.status !== "success") throw new Error("expected valid chunk");
    socket.writes.length = 0;
    await client.retransmitChunk(first.envelope.messageId, first.envelope.index);
    expect(socket.writes).toEqual([original]);
    client.cleanup();
  });

  test("accepts camel-case raw checksum envelope capability", async () => {
    const socket = new FakeSocket();
    const client = new RPCClient("test", "base64-newline");
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
});
