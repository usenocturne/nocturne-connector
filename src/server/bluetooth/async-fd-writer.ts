import { write as fsWrite } from "fs";

export type AsyncWriteOperation = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => Promise<number>;

function writeOnce(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    fsWrite(fd, buffer, offset, length, null, (error, bytesWritten) => {
      if (error) {
        reject(error);
      } else {
        resolve(bytesWritten);
      }
    });
  });
}

export async function writeAllAsync(
  fd: number,
  data: Buffer | Uint8Array,
  isCurrent: () => boolean,
  write: AsyncWriteOperation = writeOnce,
): Promise<void> {
  const buffer = Buffer.from(data);
  let offset = 0;

  while (offset < buffer.length) {
    if (!isCurrent()) throw new Error("RFCOMM connection changed during write");

    let written: number;
    try {
      written = await write(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (!isCurrent()) {
        throw new Error("RFCOMM connection changed during write", {
          cause: error,
        });
      }
      throw error;
    }

    if (!isCurrent()) throw new Error("RFCOMM connection changed during write");
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("RFCOMM write made no progress");
    }
    if (written > buffer.length - offset) {
      throw new Error("RFCOMM write exceeded the requested length");
    }
    offset += written;
  }
}
