import { describe, expect, test } from "bun:test";
import { connectorPlatformForLocation } from "./useConnectorPlatform";

describe("connectorPlatformForLocation", () => {
  test("identifies the loopback-only Windows connector host", () => {
    expect(connectorPlatformForLocation(
      "127.0.0.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "?connector-platform=windows",
    )).toBe("windows");
    expect(connectorPlatformForLocation(
      "localhost",
      "Mozilla/5.0 (Windows NT 10.0; ARM64)",
      "?connector-platform=windows",
    )).toBe("windows");
  });

  test("keeps the Pi UI on Linux defaults when opened from a Windows browser", () => {
    expect(connectorPlatformForLocation(
      "nocturne-connector.local",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "?connector-platform=windows",
    )).toBe("linux");
    expect(connectorPlatformForLocation(
      "192.168.1.42",
      "Mozilla/5.0 (Windows NT 10.0; ARM64)",
      "?connector-platform=windows",
    )).toBe("linux");
    expect(connectorPlatformForLocation(
      "127.0.0.1",
      "Mozilla/5.0 (Windows NT 10.0; ARM64)",
    )).toBe("linux");
  });
});
