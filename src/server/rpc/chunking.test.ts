import { describe, expect, test } from "bun:test";
import { crc32, createChunks, parseChunk } from "./chunking";

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
