import { gzipSync } from "zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { afterEach, describe, expect, test } from "bun:test";
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


const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function legacyService() {
  const directory = await mkdtemp(join(tmpdir(), "nocturne-legacy-test-"));
  temporaryDirectories.push(directory);
  return { directory, service: new OTAService({ platform: "win32", legacyOtaDirectory: directory }) };
}

function respond(response: Response) {
  globalThis.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect });
}

describe("legacy OTA streaming", () => {
  test("preserves bytes and both digest APIs across multiple streamed chunks", async () => {
    const { service } = await legacyService();
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const body = Buffer.concat([chunk, Buffer.from([1, 2, 3])]);
    respond(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(body.subarray(chunk.length));
        controller.close();
      },
    }), { headers: { "Content-Length": String(body.length) } }));
    const path = await service.downloadUpdate("1.0.0", "1.0.1");
    expect(await readFile(path)).toEqual(body);
    const expected = createHash("md5").update(body).digest("hex");
    expect(service.calculateMD5(path)).toBe(expected);
    expect(await service.calculateMD5Async(path)).toBe(expected);
  });

  test("keeps the previous completed download and removes partial bytes on a stream failure", async () => {
    const { directory, service } = await legacyService();
    const destination = join(directory, "nocturne-update.swu");
    await writeFile(destination, "previous verified package");
    let chunkSent = false;
    respond(new Response(new ReadableStream({
      pull(controller) {
        if (chunkSent) controller.error(new Error("Connection interrupted"));
        else { chunkSent = true; controller.enqueue(Buffer.alloc(65536, 1)); }
      },
    })));
    await expect(service.downloadUpdate("1.0.0", "1.0.1")).rejects.toThrow("Connection interrupted");
    expect(await readFile(destination, "utf8")).toBe("previous verified package");
    expect(await readdir(directory)).toEqual(["nocturne-update.swu"]);
  });

  test("rejects truncated responses without promoting them", async () => {
    const { directory, service } = await legacyService();
    respond(new Response("short", { headers: { "Content-Length": "100" } }));
    await expect(service.downloadUpdate("1.0.0", "1.0.1")).rejects.toThrow("Content-Length");
    expect(await readdir(directory)).toEqual([]);
    await expect(service.calculateMD5Async(join(directory, "missing"))).rejects.toThrow();
  });
});


test("accepts HTTP-compressed packages after Bun decompresses the transfer body", async () => {
  const { service } = await legacyService();
  const packageBytes = Buffer.alloc(10000, 0x61);
  const compressed = gzipSync(packageBytes);
  const fixtureServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(compressed, {
      headers: { "Content-Encoding": "gzip", "Content-Length": String(compressed.length) },
    }),
  });
  globalThis.fetch = Object.assign(
    (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => originalFetch(fixtureServer.url, options),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const path = await service.downloadUpdate("1.0.0", "1.0.1");
    expect(await readFile(path)).toEqual(packageBytes);
  } finally {
    fixtureServer.stop(true);
  }
});
