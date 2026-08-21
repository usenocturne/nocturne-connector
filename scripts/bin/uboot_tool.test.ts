import { expect, test } from "bun:test";
import { applyCommand, crc32, readSelector, UBOOT_RECORD_SIZE, writeCrc } from "./uboot_tool.ts";

function record(partition = 2): Uint8Array {
  const data = new Uint8Array(UBOOT_RECORD_SIZE);
  data[0] = 1;
  data[2] = partition;
  writeCrc(data, "big");
  return data;
}

test("calculates the standard CRC32 value", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

test("accepts legacy little-endian selector records during migration", () => {
  const data = record();
  writeCrc(data, "little");

  expect(readSelector(data)).toMatchObject({
    partition: 2,
    crcEncoding: "little",
    valid: true,
  });
});

test("part_switch writes the U-Boot big-endian CRC", () => {
  const data = record();
  writeCrc(data, "little");

  applyCommand(data, "part_switch");

  expect(readSelector(data)).toMatchObject({
    partition: 3,
    crcEncoding: "big",
    valid: true,
  });
});

test("reset_counter preserves slot B and writes a U-Boot-valid CRC", () => {
  const data = record(3);
  data[1] = 1;
  writeCrc(data);

  applyCommand(data, "reset_counter");

  expect(data[1]).toBe(0);
  expect(readSelector(data)).toMatchObject({
    partition: 3,
    crcEncoding: "big",
    valid: true,
  });
});

test("invalid records recover to slot A before a mutating command", () => {
  const data = new Uint8Array(UBOOT_RECORD_SIZE);
  data[2] = 3;

  applyCommand(data, "reset_counter");

  expect(readSelector(data)).toMatchObject({
    partition: 2,
    crcEncoding: "big",
    valid: true,
  });
});
