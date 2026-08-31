import { Elysia } from "elysia";
import { readFileSync } from "fs";
import { release } from "os";
import { getConnectorVersion } from "../utils/version";
import { createLogger } from "../utils/logger";

const log = createLogger("routes:info");

export interface ConnectorInfo {
  version: string;
  osVersion: string;
  platform?: "windows";
  connectorUpdateSupported?: false;
  powerControlSupported?: false;
}

export type ConnectorInfoProvider = () => ConnectorInfo | Promise<ConnectorInfo>;

export function defaultConnectorInfo(
  platform: NodeJS.Platform = process.platform,
): ConnectorInfo {
  let osVersion = "unknown";

  if (platform === "win32") {
    return {
      version: getConnectorVersion(),
      osVersion: `Windows ${release()}`,
      platform: "windows",
      connectorUpdateSupported: false,
      powerControlSupported: false,
    };
  }
  if (platform === "linux") {
    try {
      osVersion = readFileSync("/etc/alpine-release", "utf-8").trim();
    } catch (error) {
      log.debug(`Unable to read Alpine release metadata: ${error}`);
    }
  }

  return {
    version: getConnectorVersion(),
    osVersion,
  };
}

export function createInfoRoutes(
  provider: ConnectorInfoProvider = defaultConnectorInfo,
) {
  return new Elysia({ prefix: "/api" }).get("/info", () => provider());
}

export const infoRoutes = createInfoRoutes();
