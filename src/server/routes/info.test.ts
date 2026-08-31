import { describe, expect, test } from "bun:test";
import { defaultConnectorInfo } from "./info";

describe("defaultConnectorInfo", () => {
  test("identifies the Windows connector without reading Alpine metadata", () => {
    const info = defaultConnectorInfo("win32");
    expect(info.platform).toBe("windows");
    expect(info.osVersion).toStartWith("Windows ");
    expect(info.connectorUpdateSupported).toBe(false);
    expect(info.powerControlSupported).toBe(false);
  });

  test("keeps the Pi response shape unchanged", () => {
    const info = defaultConnectorInfo("linux");
    expect(info.version).toBeString();
    expect(info.osVersion).toBeString();
    expect(info).not.toHaveProperty("platform");
    expect(info).not.toHaveProperty("connectorUpdateSupported");
    expect(info).not.toHaveProperty("powerControlSupported");
  });
});
