import { describe, expect, test } from "bun:test";
import { BlueZAdapter } from "./dbus-adapter";

function discoveryFixture(errors: {
  filter?: Error;
  start?: Error;
  stop?: Error;
} = {}) {
  const adapter = new BlueZAdapter();
  const state = { discovering: false, filterAttempts: 0 };
  // Replace only the D-Bus boundary, without opening a real system bus.
  Reflect.set(adapter, "adapter", {
    async SetDiscoveryFilter() {
      state.filterAttempts++;
      if (errors.filter) throw errors.filter;
    },
    async StartDiscovery() {
      if (errors.start) throw errors.start;
      state.discovering = true;
    },
    async StopDiscovery() {
      if (errors.stop) throw errors.stop;
      state.discovering = false;
    },
  });
  return { adapter, state };
}

describe("BlueZ discovery failure handling", () => {
  test("still starts and stops discovery when the optional filter is unsupported", async () => {
    const { adapter, state } = discoveryFixture({
      filter: new Error("org.bluez.Error.NotSupported"),
    });

    await adapter.startDiscovery();
    expect(state.filterAttempts).toBe(1);
    expect(state.discovering).toBe(true);
    await adapter.stopDiscovery();
    expect(state.discovering).toBe(false);
  });

  test.each([false, true])("propagates start failure when the optional filter fails: %s", async (filterFails) => {
    const failure = new Error("org.bluez.Error.NotReady");
    const { adapter, state } = discoveryFixture({
      start: failure,
      filter: filterFails ? new Error("org.bluez.Error.NotSupported") : undefined,
    });

    await expect(adapter.startDiscovery()).rejects.toBe(failure);
    expect(state.discovering).toBe(false);
  });

  test("propagates stop failure so callers cannot report discovery stopped", async () => {
    const failure = new Error("org.bluez.Error.Failed");
    const { adapter, state } = discoveryFixture({ stop: failure });

    await adapter.startDiscovery();
    await expect(adapter.stopDiscovery()).rejects.toBe(failure);
    expect(state.discovering).toBe(true);
  });

  test("rejects starting without an adapter and allows idempotent stop", async () => {
    const adapter = new BlueZAdapter();

    await expect(adapter.startDiscovery()).rejects.toThrow("Bluetooth adapter is unavailable");
    await adapter.stopDiscovery();
  });
});
