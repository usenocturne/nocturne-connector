import { readFileSync, writeFileSync } from "node:fs";

export const UBOOT_RECORD_SIZE = 1024;
export const UBOOT_CRC_OFFSET = 1020;

export type CrcEncoding = "big" | "little" | "invalid";

export interface SelectorState {
  version: number;
  bootCounter: number;
  partition: number;
  crcEncoding: CrcEncoding;
  valid: boolean;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)) >>> 0;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) << 24) |
    ((data[offset + 1] ?? 0) << 16) |
    ((data[offset + 2] ?? 0) << 8) |
    (data[offset + 3] ?? 0)
  ) >>> 0;
}

function readUInt32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    ((data[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function writeUInt32BE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function writeUInt32LE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

export function writeCrc(data: Uint8Array, encoding: "big" | "little" = "big"): void {
  if (data.length < UBOOT_RECORD_SIZE) {
    throw new Error(`U-Boot record must be ${UBOOT_RECORD_SIZE} bytes`);
  }

  const value = crc32(data.subarray(0, UBOOT_CRC_OFFSET));
  if (encoding === "big") {
    writeUInt32BE(data, UBOOT_CRC_OFFSET, value);
  } else {
    writeUInt32LE(data, UBOOT_CRC_OFFSET, value);
  }
}

export function readSelector(data: Uint8Array): SelectorState {
  if (data.length < UBOOT_RECORD_SIZE) {
    throw new Error(`U-Boot record must be ${UBOOT_RECORD_SIZE} bytes`);
  }

  const expected = crc32(data.subarray(0, UBOOT_CRC_OFFSET));
  const crcEncoding =
    readUInt32BE(data, UBOOT_CRC_OFFSET) === expected
      ? "big"
      : readUInt32LE(data, UBOOT_CRC_OFFSET) === expected
        ? "little"
        : "invalid";

  return {
    version: data[0] ?? 0,
    bootCounter: data[1] ?? 0,
    partition: data[2] ?? 0,
    crcEncoding,
    valid: crcEncoding !== "invalid",
  };
}

function resetToDefault(data: Uint8Array): void {
  data.fill(0);
  data[0] = 1;
  data[2] = 2;
}

export function applyCommand(data: Uint8Array, command: string): boolean {
  const selector = readSelector(data);
  if (!selector.valid) {
    console.error("Invalid CRC -> fallback to default");
    resetToDefault(data);
  }

  switch (command) {
    case "version":
      console.log(`0x${(data[0] ?? 0).toString(16).padStart(2, "0")}`);
      return false;
    case "part_current":
      console.log(data[2] ?? 0);
      return false;
    case "part_switch":
      data[2] = data[2] === 2 ? 3 : 2;
      writeCrc(data);
      return true;
    case "reset_counter":
      data[1] = 0;
      writeCrc(data);
      return true;
    default:
      console.log("Unknown command");
      return false;
  }
}

function main(): void {
  const command = process.argv[2];
  if (!command) {
    console.log("Usage: uboot_tool [COMMAND]");
    console.log("Commands:");
    console.log(" part_current  - show current partition");
    console.log(" part_switch   - switch active partition");
    console.log(" reset_counter - reset boot counter");
    console.log(" version       - show version of file");
    process.exitCode = 1;
    return;
  }

  const filePath = process.env.NOCTURNE_UBOOT_FILE ?? "/uboot/uboot.dat";
  const data = new Uint8Array(readFileSync(filePath));
  const shouldSave = applyCommand(data, command);
  if (shouldSave) writeFileSync(filePath, data);
}

if (import.meta.main) main();
