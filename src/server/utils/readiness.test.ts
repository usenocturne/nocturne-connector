import { describe, expect, test } from "bun:test";
import { waitForClockSync } from "./readiness";

describe("waitForClockSync", () => {
  test("does not invoke Linux probes on Windows", async () => {
    let probes = 0;
    await waitForClockSync({
      platform: "win32",
      probe: async () => {
        probes++;
        return { synced: false };
      },
    });
    expect(probes).toBe(0);
  });

  test("preserves the Linux polling gate", async () => {
    let probes = 0;
    let sleeps = 0;
    await waitForClockSync({
      platform: "linux",
      probe: async () => ({ synced: ++probes >= 2, source: "test" }),
      sleep: async () => {
        sleeps++;
      },
    });
    expect(probes).toBe(2);
    expect(sleeps).toBe(1);
  });
});
