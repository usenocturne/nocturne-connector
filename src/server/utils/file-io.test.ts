import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, type FileHandle } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeAll } from "./file-io";

describe("OTA artifact writes", () => {
  let directory: string;
  let path: string;
  let file: FileHandle;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "connector-write-test-"));
    path = join(directory, "artifact");
    file = await open(path, "w+");
  });

  afterEach(async () => {
    await file.close();
    await rm(directory, { recursive: true });
  });

  test("persists sliced buffers in order across short writes and successive chunks", async () => {
    const write = file.write.bind(file);
    Object.defineProperty(file, "write", {
      value: (buffer: Buffer, offset: number, length: number, position: null) =>
        write(buffer, offset, Math.min(length, 3), position),
    });

    await writeAll(file, Buffer.from("prefixabcdefghsuffix").subarray(6, 14));
    await writeAll(file, Buffer.from("ijklmnop"));

    expect(await readFile(path, "utf8")).toBe("abcdefghijklmnop");
  });

  test.each([0, 3])("rejects a stalled write after %i bytes without retrying forever", async (prefixLength) => {
    const write = file.write.bind(file);
    let attempts = 0;
    Object.defineProperty(file, "write", {
      value: async (buffer: Buffer, offset: number, length: number, position: null) => {
        attempts++;
        if (prefixLength > 0 && attempts === 1) {
          return write(buffer, offset, Math.min(length, prefixLength), position);
        }
        if (attempts > 2) throw new Error("Retried a stalled write");
        return { bytesWritten: 0, buffer };
      },
    });

    await expect(writeAll(file, Buffer.from("abcdefgh")))
      .rejects.toThrow("OTA artifact write made no progress");
    expect(await readFile(path, "utf8")).toBe("abcdefgh".slice(0, prefixLength));
  });

  test("propagates an I/O failure after a partial write", async () => {
    const write = file.write.bind(file);
    const failure = new Error("No space left on device");
    Object.defineProperty(file, "write", {
      value: (buffer: Buffer, offset: number, length: number, position: null) => {
        if (offset > 0) return Promise.reject(failure);
        return write(buffer, offset, Math.min(length, 3), position);
      },
    });

    await expect(writeAll(file, Buffer.from("abcdefgh"))).rejects.toBe(failure);
    expect(await readFile(path, "utf8")).toBe("abc");
  });
});
