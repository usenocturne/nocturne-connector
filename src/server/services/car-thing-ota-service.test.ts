import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  carThingOtaVersionLanes,
  CarThingOTAService,
} from "./car-thing-ota-service";
import { MAX_OTA_TRANSFER_WINDOW_BYTES } from "./ota-transfer";

const primaryBytes = Buffer.from("signed swu fixture");
const rangeBytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("CarThingOTAService", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let stateDir: string | null = null;

  afterEach(async () => {
    server?.stop(true);
    server = null;
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    stateDir = null;
  });

  test("checks, verifies, resumes, and range-serves a v2 image update", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "nocturne-connector-ota-"));
    let manifestQuery = "";
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v2/manifest") {
          manifestQuery = url.search;
          const origin = new URL(request.url).origin;
          return Response.json({
            manifest_version: 2,
            channel: "stable",
            current_latest: "4.2.0",
            device_version: url.searchParams.get("from"),
            update_available: true,
            update: {
              update_id: "release-4.2.0",
              version: "4.2.0",
              kind: "image",
              expected_sha256: sha256(primaryBytes),
              expected_size: primaryBytes.length,
              update_url_base: `${origin}/v2/artifacts/release-4.2.0`,
              assets: [
                {
                  name: "nocturne.swu",
                  size: primaryBytes.length,
                  sha256: sha256(primaryBytes),
                },
                {
                  name: "system.img.zck",
                  size: rangeBytes.length,
                  sha256: sha256(rangeBytes),
                },
              ],
            },
          });
        }
        if (url.pathname.endsWith("/nocturne.swu")) {
          return new Response(primaryBytes);
        }
        if (url.pathname.endsWith("/system.img.zck")) {
          const header = request.headers.get("range");
          const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
          if (!match) return new Response("missing range", { status: 400 });
          const start = Number(match[1]);
          const end = Number(match[2]);
          return new Response(rangeBytes.subarray(start, end + 1), {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${end}/${rangeBytes.length}`,
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const service = new CarThingOTAService({
      serverUrl: server.url.origin,
      stateDir,
    });
    const check = await service.checkUpdate(
      "4.3.1+20260727010000",
      "stable",
      "4.2.0+20260725010000",
      "4.3.1+20260727010000",
    );
    expect(check.available).toBe(true);
    const query = new URLSearchParams(manifestQuery);
    expect(query.get("from")).toBe("4.3.1+20260727010000");
    expect(query.get("image_from")).toBe(
      "4.2.0+20260725010000",
    );
    expect(query.get("bandaid_from")).toBe(
      "4.3.1+20260727010000",
    );
    expect(check.update?.primaryAsset).toBe("nocturne.swu");
    expect(check.update?.rangeAssets[0]?.name).toBe("system.img.zck");

    const update = check.update;
    if (!update) throw new Error("expected update");
    const progress: number[] = [];
    await service.preparePrimaryArtifact(update, (downloaded) => {
      progress.push(downloaded);
    });
    expect(progress.at(-1)).toBe(primaryBytes.length);
    expect(await service.readPrimaryChunk(update, 7, 3)).toEqual(
      primaryBytes.subarray(7, 10),
    );
    expect(
      await service.readPrimaryChunk(
        update,
        0,
        MAX_OTA_TRANSFER_WINDOW_BYTES,
      ),
    ).toEqual(primaryBytes);
    await expect(
      service.readPrimaryChunk(
        update,
        0,
        MAX_OTA_TRANSFER_WINDOW_BYTES + 1,
      ),
    ).rejects.toThrow("Invalid OTA transfer size");

    await service.rememberActiveUpdate(update);
    expect(await service.activeUpdate()).toEqual(update);
    expect(
      await service.fetchAssetRange(update, update.rangeAssets[0]!, 5, 12),
    ).toEqual(rangeBytes.subarray(5, 17));

    await service.clearActiveUpdate(true);
    expect(await service.activeUpdate()).toBeNull();
    await expect(service.readPrimaryChunk(update, 0, 1)).rejects.toThrow();
  });

  test("rejects a range server that ignores the requested range", async () => {
    stateDir = await mkdtemp(join(tmpdir(), "nocturne-connector-ota-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(rangeBytes),
    });
    const service = new CarThingOTAService({ stateDir });
    const update = {
      version: "4.2.0",
      channel: "stable",
      kind: "image" as const,
      updateId: "release-4.2.0",
      expectedSha256: sha256(primaryBytes),
      expectedSize: primaryBytes.length,
      updateUrlBase: server.url.origin,
      primaryAsset: "nocturne.swu",
      rangeAssets: [
        {
          name: "system.img.zck",
          size: rangeBytes.length,
          sha256: sha256(rangeBytes),
        },
      ],
      requiresReflash: false,
      flashthingZipUrl: null,
    };

    await expect(
      service.fetchAssetRange(update, update.rangeAssets[0]!, 0, 4),
    ).rejects.toThrow("HTTP 200");
  });

  test("accepts a bandaid manifest with one primary tar asset", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const origin = new URL(request.url).origin;
        return Response.json({
          manifest_version: 2,
          channel: "stable",
          current_latest: "4.3.1",
          device_version: "4.3.0",
          image_version: "4.2.0",
          bandaid_version: "4.3.0",
          update_available: true,
          update: {
            update_id: "bandaid-4.3.1",
            version: "4.3.1",
            kind: "bandaid",
            minimum_image_version: "4.2.0",
            expected_sha256: sha256(primaryBytes),
            expected_size: primaryBytes.length,
            update_url_base: `${origin}/v2/artifacts/bandaid-4.3.1`,
            assets: [
              {
                name: "nocturne-bandaid.tar.zst",
                size: primaryBytes.length,
                sha256: sha256(primaryBytes),
              },
            ],
          },
        });
      },
    });
    const service = new CarThingOTAService({ serverUrl: server.url.origin });

    const check = await service.checkUpdate(
      "4.3.0",
      "stable",
      "4.2.0",
      "4.3.0",
    );

    expect(check.update?.kind).toBe("bandaid");
    expect(check.update?.primaryAsset).toBe("nocturne-bandaid.tar.zst");
    expect(check.update?.rangeAssets).toEqual([]);
  });

  test("old device versions populate both OTA version lanes", () => {
    expect(carThingOtaVersionLanes(" 4.1.0 ", null, "")).toEqual({
      currentVersion: "4.1.0",
      imageVersion: "4.1.0",
      bandaidVersion: "4.1.0",
    });
    expect(carThingOtaVersionLanes(" ", "4.1.0", "4.1.0")).toBeNull();
  });
});
