import { describe, expect, test } from "bun:test";
import { OTAService } from "./ota-service";

describe("OTAService Windows connector updates", () => {
  test("reports connector self-updates unsupported without affecting OTA service construction", async () => {
    const service = new OTAService({ platform: "win32" });

    expect(service.getConnectorUpdateStatus().supported).toBe(false);
    await expect(service.checkConnectorUpdate("stable")).resolves.toMatchObject({
      updateAvailable: false,
      channel: "stable",
      message: "Connector self-updates are not supported on Windows.",
    });
  });

  test("rejects attempts to start an in-place connector update", async () => {
    const service = new OTAService({ platform: "win32" });

    await expect(service.startConnectorUpdate()).rejects.toThrow(
      "Connector self-updates are not supported on Windows",
    );
  });
});
