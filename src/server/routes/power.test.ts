import { describe, expect, test } from "bun:test";
import { createPowerRoutes } from "./power";

describe("power routes", () => {
  test("never reboots the Windows host", async () => {
    let rebootCalls = 0;
    const app = createPowerRoutes({
      platform: "win32",
      reboot: async () => {
        rebootCalls++;
      },
    });

    const response = await app.handle(
      new Request("http://localhost/api/power/reboot", { method: "POST" }),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      status: "unsupported",
      error: "Rebooting the Windows host is not supported by Nocturne Connector",
    });
    expect(rebootCalls).toBe(0);
  });
});
