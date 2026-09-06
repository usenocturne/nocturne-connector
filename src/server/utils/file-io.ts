import type { FileHandle } from "fs/promises";

export async function writeAll(
  file: Pick<FileHandle, "write">,
  bytes: Buffer,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      null,
    );
    if (result.bytesWritten === 0) {
      throw new Error("OTA artifact write made no progress");
    }
    written += result.bytesWritten;
  }
}
