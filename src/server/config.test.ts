import { describe, expect, test } from "bun:test";
import {
  defaultConnectorBindHost,
  defaultConnectorPort,
  defaultConnectorStateDir,
} from "./config";

describe("defaultConnectorStateDir", () => {
  test("preserves an explicit state directory on every platform", () => {
    expect(
      defaultConnectorStateDir("win32", {
        NOCTURNE_CONNECTOR_STATE_DIR: "D:\\NocturneState",
      }),
    ).toBe("D:\\NocturneState");
  });

  test("uses LOCALAPPDATA for the Windows per-user state directory", () => {
    expect(
      defaultConnectorStateDir(
        "win32",
        { LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local" },
        "C:\\Users\\Tester",
      ),
    ).toBe("C:\\Users\\Tester\\AppData\\Local\\Nocturne\\Connector");
  });

  test("falls back to the conventional Windows local app data path", () => {
    expect(defaultConnectorStateDir("win32", {}, "C:\\Users\\Tester")).toBe(
      "C:\\Users\\Tester\\AppData\\Local\\Nocturne\\Connector",
    );
  });
});

describe("connector network defaults", () => {
  test("preserves the Pi bind and port behavior", () => {
    expect(defaultConnectorBindHost("linux", {
      NOCTURNE_CONNECTOR_BIND_HOST: "127.0.0.1",
    })).toBe("0.0.0.0");
    expect(defaultConnectorPort("linux", { PORT: "0" })).toBe(80);
    expect(defaultConnectorPort("linux", { PORT: "8080" })).toBe(8080);
  });

  test("keeps Windows loopback-only on an OS-selected port", () => {
    expect(defaultConnectorBindHost("win32", {})).toBe("127.0.0.1");
    expect(defaultConnectorBindHost("win32", {
      NOCTURNE_CONNECTOR_BIND_HOST: "0.0.0.0",
    })).toBe("127.0.0.1");
    expect(defaultConnectorPort("win32", {})).toBe(0);
  });
});
