import { describe, expect, test } from "bun:test";
import { ChunkedMessageAssembler, crc32, createChunks, parseChunk } from "./chunking";

const MESSAGE_ID = "12345678-1234-1234-1234-123456789abc";
const GOLDEN_CHUNKS = [
  "2431323334353637382d313233342d313233342d313233342d313233343536373839616263000000023610a686000568656c6c6f",
  "2431323334353637382d313233342d313233342d313233342d313233343536373839616263000100023a7711430005776f726c64",
];

describe("RPC checksum compatibility", () => {
  test("matches IEEE CRC32 vectors, including every byte value", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Uint8Array.from({ length: 256 }, (_, i) => i))).toBe(0x29058c73);
    expect(crc32(Buffer.from("prefix123456789suffix").subarray(6, 15)))
      .toBe(0xcbf43926);
  });

  test("preserves the complete multi-chunk wire envelope", () => {
    expect(createChunks(Buffer.from("helloworld"), MESSAGE_ID, 5).map(
      (chunk) => chunk.toString("hex"),
    )).toEqual(GOLDEN_CHUNKS);
  });

  test("accepts golden peer chunks and rejects a corrupted payload", () => {
    for (const [index, hex] of GOLDEN_CHUNKS.entries()) {
      const chunk = Buffer.from(hex, "hex");
      const parsed = parseChunk(chunk);
      expect(parsed).toMatchObject({
        status: "success",
        envelope: { messageId: MESSAGE_ID, index, total: 2 },
        payload: Buffer.from(index === 0 ? "hello" : "world"),
        consumed: chunk.length,
      });
      chunk[chunk.length - 1] ^= 1;
      expect(parseChunk(chunk)).toMatchObject({
        status: "invalid",
        reason: "checksum mismatch",
      });
    }
  });
});

describe("ChunkedMessageAssembler", () => {
  test("ignores a chunk whose total disagrees with the message's first chunk", () => {
    const assembler = new ChunkedMessageAssembler();
    expect(assembler.addChunk("m", 0, 2, Buffer.from("he"))).toBeNull();
    expect(assembler.addChunk("m", 1, 3, Buffer.from("xx"))).toBeNull();
    expect(assembler.addChunk("m", 1, 2, Buffer.from("llo"))?.toString()).toBe("hello");
  });

  test("evicts only messages that have been idle past the cutoff", () => {
    const assembler = new ChunkedMessageAssembler();
    for (let i = 0; i < 6; i++) assembler.addChunk(`stale-${i}`, 0, 2, Buffer.from("a"), 1_000);
    assembler.addChunk("mismatched", 0, 2, Buffer.from("he"), 1_000);
    assembler.addChunk("mismatched", 1, 3, Buffer.from("ignored"), 5_000);
    assembler.addChunk("other-active", 0, 2, Buffer.from("wo"), 9_000);

    expect(assembler.evictIdleSince(2_000)).toBe(7);
    expect(assembler.pendingCount).toBe(1);
    expect(assembler.addChunk("other-active", 1, 2, Buffer.from("rld"), 9_500)?.toString()).toBe(
      "world",
    );
  });
});
