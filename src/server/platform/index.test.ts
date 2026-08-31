import { describe, expect, test } from "bun:test";
import { createPlatformComposition } from "./index";
import type { HostBridgeClient } from "./host-bridge";

const bridge: HostBridgeClient = {
  async call<TResult = unknown>() {
    return {} as TResult;
  },
  onEvent() {
    return () => {};
  },
  close() {},
};

describe("platform composition", () => {
  test("uses Windows native seams without changing non-Windows composition", () => {
    const windows = createPlatformComposition({
      platform: "win32",
      hostBridge: bridge,
    });
    expect(windows.hostBridge).toBe(bridge);
    expect(windows.sessionProtector).not.toBeNull();

    const other = createPlatformComposition({ platform: "darwin" });
    expect(other.hostBridge).toBeNull();
    expect(other.sessionProtector).toBeNull();
  });

  test("requires the host pipe and token when constructing Windows IPC", () => {
    expect(() =>
      createPlatformComposition({
        platform: "win32",
        hostPipePath: "",
        hostPipeToken: "secret",
      }),
    ).toThrow("NOCTURNE_HOST_PIPE");
    expect(() =>
      createPlatformComposition({
        platform: "win32",
        hostPipePath: "\\\\.\\pipe\\nocturne",
        hostPipeToken: "",
      }),
    ).toThrow("NOCTURNE_HOST_TOKEN");
  });
});
