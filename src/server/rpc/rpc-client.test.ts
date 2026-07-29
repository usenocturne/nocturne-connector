import { describe, expect, test } from "bun:test";
import { parseChunk } from "./chunking";
import { decode } from "./msgpack-codec";
import { RPCClient } from "./rpc-client";

class FakeSocket {
  readonly writes: Buffer[] = [];

  write(data: Buffer | Uint8Array): void {
    this.writes.push(Buffer.from(data));
  }

  end(): void {}
}

describe("RPCClient", () => {
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

  test("lets normal traffic preempt a bulk transfer between chunks", async () => {
    const writes: Buffer[] = [];
    const client = new RPCClient("test");
    let normalSend: Promise<void> | undefined;
    client.setSocket({
      write(data) {
        writes.push(Buffer.from(data));
        if (writes.length === 1) {
          normalSend = client.sendEvent("control.event", { ready: true });
        }
      },
      end() {},
    });

    await client.sendEvent("ota.chunk", { bytes: Buffer.alloc(8_000, 7) });
    await normalSend;

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
