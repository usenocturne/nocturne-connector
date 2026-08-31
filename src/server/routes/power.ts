import { Elysia } from "elysia";
import { runShell } from "../utils/shell";

export interface PowerRoutesOptions {
  platform?: NodeJS.Platform;
  reboot?: () => Promise<void>;
}

export function createPowerRoutes(options: PowerRoutesOptions = {}) {
  const platform = options.platform ?? process.platform;
  const reboot = options.reboot ?? (() => runShell("reboot").then(() => undefined));

  return new Elysia({ prefix: "/api/power" }).post("/reboot", ({ set }) => {
    if (platform === "win32") {
      set.status = 501;
      return {
        status: "unsupported",
        error: "Rebooting the Windows host is not supported by Nocturne Connector",
      };
    }
    setTimeout(() => {
      reboot().catch(() => undefined);
    }, 1000);
    return { status: "success" };
  });
}

export const powerRoutes = createPowerRoutes();
