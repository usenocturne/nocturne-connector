import { describe, expect, test } from "bun:test";
import { decode } from "@msgpack/msgpack";
import { frame } from "./host-bridge";

const GOLDEN_FRAMES = [
  {
    name: "request",
    value: {
      type: "request",
      id: 1,
      token: "secret",
      generation: 1,
      method: "ping",
      params: {},
    },
    hex: "3f00000086a474797065a772657175657374a2696401a5746f6b656ea6736563726574aa67656e65726174696f6e01a66d6574686f64a470696e67a6706172616d7380",
  },
  {
    name: "response",
    value: {
      type: "response",
      id: 1,
      generation: 1,
      result: { status: "ok" },
    },
    hex: "3100000084a474797065a8726573706f6e7365a2696401aa67656e65726174696f6e01a6726573756c7481a6737461747573a26f6b",
  },
  {
    name: "binary event",
    value: {
      type: "event",
      topic: "rfcomm.client.data",
      data: { data: Uint8Array.from([0, 1, 255]) },
      generation: 1,
    },
    hex: "4100000084a474797065a56576656e74a5746f706963b27266636f6d6d2e636c69656e742e64617461a46461746181a464617461c4030001ffaa67656e65726174696f6e01",
  },
] as const;

describe("native bridge golden frames", () => {
  for (const fixture of GOLDEN_FRAMES) {
    test(fixture.name, () => {
      const encoded = frame(fixture.value).toString("hex");
      expect(encoded).toBe(fixture.hex);
      const bytes = Buffer.from(fixture.hex, "hex");
      expect(decode(bytes.subarray(4), { useBigInt64: false })).toEqual(fixture.value);
    });
  }
});
