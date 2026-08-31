import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import type { Server } from "bun";
import { BIND_HOST, CLIENT_DIST_DIR, PORT } from "./config";
import { createLogger } from "./utils/logger";
import { waitForClockSync } from "./utils/readiness";
import { NocturneManager } from "./nocturne-manager";
import { createInfoRoutes } from "./routes/info";
import { createPowerRoutes } from "./routes/power";
import { createAuthRoutes } from "./routes/auth";
import { createSetupRoutes } from "./routes/setup";
import { createSpotifyRoutes } from "./routes/spotify";
import { createBluetoothRoutes } from "./routes/bluetooth";
import { createDeviceRoutes } from "./routes/device";
import { createAnalyticsRoutes } from "./routes/analytics";
import { createOtaRoutes } from "./routes/ota";
import { createMediaRoutes } from "./routes/media";
import { existsSync } from "fs";
import { createPlatformComposition } from "./platform";
import { fileURLToPath } from "url";
import { embeddedFiles } from "bun";

const log = createLogger("Server");

process.on("unhandledRejection", (reason) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  log.error(`Unhandled promise rejection (continuing): ${detail}`);
});

process.on("uncaughtException", (err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  log.error(`Uncaught exception (continuing): ${detail}`);
});

const WS_TOPIC = "events";
let serverRef: Server<unknown> | null = null;
let wsClientCount = 0;

function broadcast(type: string, data: any): void {
  if (!serverRef) return;
  const msg = JSON.stringify({ type: "event", topic: type, data });
  serverRef.publish(WS_TOPIC, msg);
}

async function fetchAndApplyTimezone(): Promise<void> {
  if (process.platform !== "linux") return;

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const tzRes = await fetch("https://api.usenocturne.com/v1/timezone");
      if (!tzRes.ok) {
        log.warn(`Timezone fetch attempt ${attempt} returned HTTP ${tzRes.status}`);
      } else {
        const { timezone } = (await tzRes.json()) as { timezone?: string };
        if (timezone) {
          process.env.TZ = timezone;
          const { writeFileSync, existsSync, symlinkSync, unlinkSync } = await import("fs");
          const zonefile = `/usr/share/zoneinfo/${timezone}`;
          if (existsSync(zonefile)) {
            try { unlinkSync("/etc/localtime"); } catch {}
            symlinkSync(zonefile, "/etc/localtime");
            writeFileSync("/etc/timezone", timezone + "\n");
          }
          log.info(`Timezone set to ${timezone}`);
          return;
        }
      }
    } catch (err) {
      log.warn(`Timezone fetch attempt ${attempt} failed: ${err}`);
    }
    if (attempt < maxAttempts) {
      const backoffMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  log.warn(`Giving up on timezone fetch after ${maxAttempts} attempts; using system default`);
}

async function main() {
  log.info("Starting Nocturne Connector...");

  const platform = createPlatformComposition();
  const manager = new NocturneManager({
    bluetoothService: platform.bluetoothService,
    hostBridge: platform.hostBridge ?? undefined,
    sessionProtector: platform.sessionProtector ?? undefined,
  });
  manager.setWSBroadcast(broadcast);
  await manager.initializeOffline();

  const app = new Elysia()
    .use(cors())
    .use(createInfoRoutes())
    .use(createPowerRoutes())
    .use(createAuthRoutes(manager.authService, manager.setupStateService))
    .use(createSetupRoutes(manager.setupStateService))
    .use(createSpotifyRoutes(manager.spotifyService))
    .use(createBluetoothRoutes(manager.bluetoothService))
    .use(createDeviceRoutes(manager))
    .use(createAnalyticsRoutes(manager.analyticsService))
    .use(createMediaRoutes(manager.systemMediaService))
    .use(createOtaRoutes(manager.otaService))
    .ws("/ws", {
      open(ws) {
        ws.subscribe(WS_TOPIC);
        wsClientCount++;
        log.info(`WebSocket client connected (${wsClientCount} total)`);
      },
      message(ws, message) {
        try {
          const msg = typeof message === "string" ? JSON.parse(message) : message;
          if (msg.type === "request" && msg.method) {
            manager
              .onCall(msg.id || "ws", msg.method, msg.params || {})
              .then((response) => {
                ws.send(
                  JSON.stringify({
                    type: "response",
                    id: msg.id,
                    ...(response.error
                      ? { error: response.error }
                      : { result: response.result }),
                  })
                );
              })
              .catch((err: any) => {
                ws.send(
                  JSON.stringify({
                    type: "response",
                    id: msg.id,
                    error: err.message,
                  })
                );
              });
          }
        } catch {
        }
      },
      close() {
        wsClientCount = Math.max(0, wsClientCount - 1);
        log.info(`WebSocket client disconnected (${wsClientCount} remaining)`);
      },
    });

  const windowsHost = process.platform === "win32";
  const staticDir = windowsHost
    ? CLIENT_DIST_DIR ?? fileURLToPath(new URL("../dist/client", import.meta.url))
    : new URL("../dist/client", import.meta.url).pathname;
  const embeddedClient = new Map<string, Blob>();
  for (const asset of windowsHost ? embeddedFiles : []) {
    const name = (asset as Blob & { name?: string }).name;
    if (!name) continue;
    const normalizedName = name.replaceAll("\\", "/");
    const marker = "/client/";
    const markerIndex = normalizedName.lastIndexOf(marker);
    if (markerIndex >= 0) {
      embeddedClient.set(normalizedName.slice(markerIndex + marker.length), asset);
    } else if (normalizedName.startsWith("client/")) {
      embeddedClient.set(normalizedName.slice("client/".length), asset);
    } else {
      const basename = normalizedName.slice(normalizedName.lastIndexOf("/") + 1);
      const extensionIndex = basename.lastIndexOf(".");
      const stem = extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
      const extension = extensionIndex > 0 ? basename.slice(extensionIndex) : "";
      const segments = stem.split("-");
      const hasBunAssetHash = segments.length >= 3 && /^[a-z0-9]{8}$/i.test(segments.at(-1) ?? "");
      const originalBasename = hasBunAssetHash
        ? `${segments.slice(0, -1).join("-")}${extension}`
        : basename;
      if (extension === ".html" && stem.startsWith("index-")) {
        embeddedClient.set("index.html", asset);
      } else if (extension) {
        embeddedClient.set(`assets/${basename}`, asset);
        if (originalBasename !== basename) {
          embeddedClient.set(`assets/${originalBasename}`, asset);
        }
      }
    }
  }
  const hasStaticFiles = existsSync(staticDir) || embeddedClient.size > 0;
  log.info(
    `Static file directory: ${staticDir} (exists: ${existsSync(staticDir)}, embedded: ${embeddedClient.size})`,
  );
  if (hasStaticFiles) {
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    const getMime = (path: string): string => {
      const ext = path.substring(path.lastIndexOf("."));
      return mimeTypes[ext] || "application/octet-stream";
    };

    const staticFile = (relativePath: string): Blob =>
      embeddedClient.get(relativePath) ?? Bun.file(`${staticDir}/${relativePath}`);

    app.get("/assets/*", ({ params }) => {
      const relativePath = `assets/${params["*"]}`;
      const filePath = `${staticDir}/${relativePath}`;
      const file = staticFile(relativePath);
      return new Response(file, {
        headers: { "content-type": getMime(filePath) },
      });
    });

    app.get("*", ({ path }) => {
      if (path.startsWith("/api/") || path === "/ws") return;
      return new Response(staticFile("index.html"), {
        headers: { "content-type": "text/html" },
      });
    });
  }

  app.listen({ hostname: BIND_HOST, port: PORT });
  serverRef = app.server ?? null;
  const boundPort = app.server?.port ?? PORT;
  log.info(`Server listening on http://${BIND_HOST}:${boundPort}`);
  if (windowsHost && process.env.NOCTURNE_HOST_PIPE) {
    process.stdout.write(`NOCTURNE_READY_PORT=${boundPort}\n`);
  }
  void runOnlineInit(manager);
}

async function runOnlineInit(manager: NocturneManager): Promise<void> {
  try {
    await waitForClockSync();
  } catch (err) {
    log.error(`Readiness gate failed unexpectedly: ${err}`);
    return;
  }

  try {
    await fetchAndApplyTimezone();
  } catch (err) {
    log.warn(`Timezone fetch failed (non-fatal, using system default): ${err}`);
  }

  try {
    await manager.initializeOnline();
  } catch (err) {
    log.error(`Auth restore failed after readiness gate: ${err}`);
  }
}

main().catch((err) => {
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
