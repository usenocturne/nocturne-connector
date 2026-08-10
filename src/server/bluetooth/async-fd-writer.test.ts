import { describe, expect, test } from "bun:test";
import { writeAllAsync } from "./async-fd-writer";

describe("writeAllAsync", () => {
  test("loops over partial asynchronous writes in order", async () => {
    const offsets: number[] = [];
    const lengths: number[] = [];

    await writeAllAsync(7, Buffer.alloc(7), () => true, async (
      fd,
      _buffer,
      offset,
      length,
    ) => {
      expect(fd).toBe(7);
      offsets.push(offset);
      lengths.push(length);
      await Promise.resolve();
      return Math.min(length, 3);
    });

    expect(offsets).toEqual([0, 3, 6]);
    expect(lengths).toEqual([7, 4, 1]);
  });

  test("rejects when the captured connection changes during a write", async () => {
    let current = true;
    let finishWrite: ((written: number) => void) | undefined;
    const pending = writeAllAsync(
      7,
      Buffer.alloc(4),
      () => current,
      () => new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );

    await Promise.resolve();
    current = false;
    finishWrite?.(4);

    await expect(pending).rejects.toThrow("connection changed during write");
  });
});
