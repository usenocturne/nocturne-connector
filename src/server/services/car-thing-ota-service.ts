import { createHash } from "crypto";
import { createReadStream } from "fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "path";
import { CONNECTOR_STATE_DIR, OTA_SERVER_URL } from "../config";
import { requireOtaTransferWindow } from "./ota-transfer";

export type CarThingOtaKind =
  | "image"
  | "daemon"
  | "builtinWebapp"
  | "bandaid";

export interface CarThingOtaAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface CarThingAvailableUpdate {
  version: string;
  channel: string;
  kind: CarThingOtaKind;
  updateId: string;
  expectedSha256: string;
  expectedSize: number;
  updateUrlBase: string;
  primaryAsset: string;
  rangeAssets: CarThingOtaAsset[];
  requiresReflash: boolean;
  flashthingZipUrl: string | null;
}

export interface CarThingUpdateCheck {
  available: boolean;
  channel: string;
  update: CarThingAvailableUpdate | null;
}

export interface CarThingOtaVersionLanes {
  currentVersion: string;
  imageVersion: string;
  bandaidVersion: string;
}

type FetchLike = typeof fetch;

interface CarThingOTAServiceOptions {
  serverUrl?: string;
  stateDir?: string;
  fetchImpl?: FetchLike;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UPDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_WIRE_SIZE = 0xffff_ffff;

export class CarThingOTAService {
  private readonly serverUrl: string;
  private readonly stateDir: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CarThingOTAServiceOptions = {}) {
    this.serverUrl = (options.serverUrl ?? OTA_SERVER_URL).replace(/\/$/, "");
    this.stateDir = options.stateDir ?? join(CONNECTOR_STATE_DIR, "car-thing-ota");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkUpdate(
    currentVersion: string,
    channel: string,
    imageVersion?: string | null,
    bandaidVersion?: string | null,
  ): Promise<CarThingUpdateCheck> {
    const versions = carThingOtaVersionLanes(
      currentVersion,
      imageVersion,
      bandaidVersion,
    );
    if (!versions) throw new Error("Device version is unavailable");

    const url = new URL(`${this.serverUrl}/v2/manifest`);
    url.searchParams.set("channel", channel);
    url.searchParams.set("from", versions.currentVersion);
    url.searchParams.set("image_from", versions.imageVersion);
    url.searchParams.set("bandaid_from", versions.bandaidVersion);

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`OTA manifest returned HTTP ${response.status}`);
    }

    const manifest = asRecord(await response.json(), "OTA manifest");
    const responseChannel = optionalString(manifest.channel) ?? channel;
    if (manifest.update_available !== true) {
      return { available: false, channel: responseChannel, update: null };
    }

    const update = parseAvailableUpdate(
      asRecord(manifest.update, "OTA manifest update"),
      responseChannel,
    );
    return { available: true, channel: responseChannel, update };
  }

  async preparePrimaryArtifact(
    update: CarThingAvailableUpdate,
    onProgress?: (downloaded: number, total: number) => void | Promise<void>,
  ): Promise<string> {
    await mkdir(this.stateDir, { recursive: true });
    const destination = this.primaryPath(update);
    if (await this.verifyFile(destination, update.expectedSize, update.expectedSha256)) {
      await onProgress?.(update.expectedSize, update.expectedSize);
      return destination;
    }

    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    const response = await this.fetchImpl(
      `${update.updateUrlBase.replace(/\/$/, "")}/${encodeURIComponent(update.primaryAsset)}`,
      {
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(30 * 60_000),
      },
    );
    if (response.status !== 200 || !response.body) {
      throw new Error(`OTA artifact returned HTTP ${response.status}`);
    }

    const file = await open(partial, "w", 0o600);
    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    let downloaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        downloaded += chunk.length;
        if (downloaded > update.expectedSize) {
          throw new Error(
            `OTA artifact exceeded expected size ${update.expectedSize}`,
          );
        }
        hasher.update(chunk);
        await writeAll(file, chunk);
        await onProgress?.(downloaded, update.expectedSize);
      }
      await file.sync();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await rm(partial, { force: true });
      throw error;
    } finally {
      await file.close();
    }

    const digest = hasher.digest("hex");
    if (downloaded !== update.expectedSize) {
      await rm(partial, { force: true });
      throw new Error(
        `OTA artifact size mismatch: expected ${update.expectedSize}, got ${downloaded}`,
      );
    }
    if (digest !== update.expectedSha256) {
      await rm(partial, { force: true });
      throw new Error(
        `OTA artifact hash mismatch: expected ${update.expectedSha256}, got ${digest}`,
      );
    }

    await rm(destination, { force: true });
    await rename(partial, destination);
    return destination;
  }

  async rememberActiveUpdate(update: CarThingAvailableUpdate): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const next = `${this.sessionPath()}.next`;
    const persisted = {
      version: update.version,
      channel: update.channel,
      kind: update.kind,
      update_id: update.updateId,
      expected_sha256: update.expectedSha256,
      expected_size: update.expectedSize,
      update_url_base: update.updateUrlBase,
      assets: [
        {
          name: update.primaryAsset,
          size: update.expectedSize,
          sha256: update.expectedSha256,
        },
        ...update.rangeAssets,
      ],
      requires_reflash: update.requiresReflash,
      flashthing_zip_url: update.flashthingZipUrl,
    };
    await writeFile(next, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    await rename(next, this.sessionPath());
  }

  async activeUpdate(): Promise<CarThingAvailableUpdate | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.sessionPath(), "utf8"));
      return parseAvailableUpdate(asRecord(parsed, "persisted OTA session"));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readPrimaryChunk(
    update: CarThingAvailableUpdate,
    offset: number,
    size: number,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Invalid OTA offset ${offset}`);
    }
    requireOtaTransferWindow(size);
    const path = this.primaryPath(update);
    const metadata = await stat(path);
    if (offset >= metadata.size) {
      throw new Error(`OTA offset ${offset} is outside ${metadata.size}-byte artifact`);
    }
    const length = Math.min(size, metadata.size - offset);
    const data = Buffer.alloc(length);
    const file = await open(path, "r");
    try {
      let read = 0;
      while (read < length) {
        const result = await file.read(data, read, length - read, offset + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      return data.subarray(0, read);
    } finally {
      await file.close();
    }
  }

  async fetchAssetRange(
    update: CarThingAvailableUpdate,
    asset: CarThingOtaAsset,
    start: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length <= 0 ||
      start + length > asset.size
    ) {
      throw new Error(`Invalid range ${start}+${length} for ${asset.name}`);
    }
    const end = start + length - 1;
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(
      `${update.updateUrlBase.replace(/\/$/, "")}/${encodeURIComponent(asset.name)}`,
      {
        headers: { Range: `bytes=${start}-${end}` },
        signal: requestSignal,
      },
    );
    if (response.status !== 206) {
      throw new Error(`OTA range returned HTTP ${response.status}`);
    }
    const expectedContentRange = `bytes ${start}-${end}/${asset.size}`;
    if (response.headers.get("content-range") !== expectedContentRange) {
      throw new Error(
        `OTA range Content-Range mismatch: expected ${expectedContentRange}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== length) {
      throw new Error(`OTA range returned ${bytes.length} bytes, expected ${length}`);
    }
    return bytes;
  }

  async clearActiveUpdate(deleteArtifact: boolean): Promise<void> {
    const active = await this.activeUpdate().catch(() => null);
    await rm(this.sessionPath(), { force: true });
    await rm(`${this.sessionPath()}.next`, { force: true });
    if (deleteArtifact && active) {
      await rm(this.primaryPath(active), { force: true });
      await rm(`${this.primaryPath(active)}.part`, { force: true });
    }
  }

  private primaryPath(update: CarThingAvailableUpdate): string {
    return join(this.stateDir, `${update.updateId}-${update.primaryAsset}`);
  }

  private sessionPath(): string {
    return join(this.stateDir, "active.json");
  }

  private async verifyFile(
    path: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<boolean> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.size !== expectedSize) return false;

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return hash.digest("hex") === expectedSha256;
  }
}

export function carThingOtaVersionLanes(
  currentVersion: string | null | undefined,
  imageVersion: string | null | undefined,
  bandaidVersion: string | null | undefined,
): CarThingOtaVersionLanes | null {
  const current = nonEmptyString(currentVersion);
  if (!current) return null;
  return {
    currentVersion: current,
    imageVersion: nonEmptyString(imageVersion) ?? current,
    bandaidVersion: nonEmptyString(bandaidVersion) ?? current,
  };
}

function parseAvailableUpdate(
  raw: Record<string, unknown>,
  fallbackChannel = "stable",
): CarThingAvailableUpdate {
  const updateId = requiredString(raw.update_id ?? raw.updateId, "update_id");
  if (!UPDATE_ID_PATTERN.test(updateId) || updateId.includes("..")) {
    throw new Error("OTA update_id contains unsupported characters");
  }
  const kind = requiredString(raw.kind, "kind");
  if (!isOtaKind(kind)) throw new Error(`Unsupported OTA kind ${kind}`);

  const expectedSha256 = requiredString(
    raw.expected_sha256 ?? raw.expectedSha256,
    "expected_sha256",
  ).toLowerCase();
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("OTA expected_sha256 must be 64 hexadecimal characters");
  }

  const expectedSize = requiredNumber(
    raw.expected_size ?? raw.expectedSize,
    "expected_size",
  );
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_WIRE_SIZE) {
    throw new Error(`OTA expected_size ${expectedSize} is outside the wire limit`);
  }

  const assets = requiredArray(raw.assets, "assets").map((value) =>
    parseAsset(asRecord(value, "OTA asset")),
  );
  if (assets.length === 0) throw new Error("OTA manifest has no assets");
  const primary = assets[0];
  if (primary.size !== expectedSize || primary.sha256 !== expectedSha256) {
    throw new Error("OTA primary asset does not match expected size and SHA-256");
  }

  return {
    version: requiredString(raw.version, "version"),
    channel: optionalString(raw.channel) ?? fallbackChannel,
    kind,
    updateId,
    expectedSha256,
    expectedSize,
    updateUrlBase: requiredString(
      raw.update_url_base ?? raw.updateUrlBase,
      "update_url_base",
    ),
    primaryAsset: primary.name,
    rangeAssets: assets.slice(1),
    requiresReflash:
      raw.requires_reflash === true || raw.requiresReflash === true,
    flashthingZipUrl:
      optionalString(raw.flashthing_zip_url ?? raw.flashthingZipUrl) ?? null,
  };
}

function parseAsset(raw: Record<string, unknown>): CarThingOtaAsset {
  const name = requiredString(raw.name, "asset name");
  if (!ASSET_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(`Invalid OTA asset name ${name}`);
  }
  const size = requiredNumber(raw.size, `${name} size`);
  const sha256 = requiredString(raw.sha256, `${name} sha256`).toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_WIRE_SIZE) {
    throw new Error(`Invalid OTA asset size ${size} for ${name}`);
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Invalid OTA asset SHA-256 for ${name}`);
  }
  return { name, size, sha256 };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function isOtaKind(value: string): value is CarThingOtaKind {
  return ["image", "daemon", "builtinWebapp", "bandaid"].includes(value);
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      null,
    );
    if (result.bytesWritten === 0) {
      throw new Error("OTA artifact write made no progress");
    }
    written += result.bytesWritten;
  }
}
