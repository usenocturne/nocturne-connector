import { createHash } from "crypto";
import { createReadStream } from "fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "fs/promises";
import { dirname, join } from "path";
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
const MAX_ASSET_NAME_LENGTH = 128;
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

  async prepareUpdateArtifacts(
    update: CarThingAvailableUpdate,
    onProgress?: (downloaded: number, total: number) => void | Promise<void>,
  ): Promise<void> {
    const assets = updateAssets(update);
    const total = assets.reduce((sum, asset) => sum + asset.size, 0);
    let completed = 0;

    for (const asset of assets) {
      await this.prepareArtifact(update, asset, async (downloaded) => {
        await onProgress?.(completed + downloaded, total);
      });
      completed += asset.size;
    }
  }

  async verifyPreparedUpdate(update: CarThingAvailableUpdate): Promise<boolean> {
    for (const asset of updateAssets(update)) {
      if (!(await this.verifyFile(
        this.assetPath(update, asset),
        asset.size,
        asset.sha256,
      ))) {
        return false;
      }
    }
    return true;
  }

  async rememberActiveUpdate(update: CarThingAvailableUpdate): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
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
    await writeFileAtomically(
      this.sessionPath(),
      Buffer.from(`${JSON.stringify(persisted)}\n`),
    );
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
    const path = this.assetPath(update, primaryAsset(update));
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== update.expectedSize) {
      throw new Error(`Cached OTA primary asset ${update.primaryAsset} is unavailable`);
    }
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

  async readAssetRange(
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
    requireOtaTransferWindow(length);
    if (signal?.aborted) throw abortError();

    const path = this.assetPath(update, asset);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== asset.size) {
      throw new Error(`Cached OTA asset ${asset.name} is unavailable`);
    }

    const bytes = Buffer.alloc(length);
    const file = await open(path, "r");
    try {
      let read = 0;
      while (read < length) {
        if (signal?.aborted) throw abortError();
        const result = await file.read(
          bytes,
          read,
          length - read,
          start + read,
        );
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read !== length) {
        throw new Error(
          `Cached OTA asset ${asset.name} returned ${read} bytes, expected ${length}`,
        );
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  async clearActiveUpdate(deleteArtifact: boolean): Promise<void> {
    if (deleteArtifact) {
      await rm(this.stateDir, { recursive: true, force: true });
      return;
    }
    await rm(this.sessionPath(), { force: true });
    await rm(`${this.sessionPath()}.next`, { force: true });
  }

  private assetPath(
    update: CarThingAvailableUpdate,
    asset: CarThingOtaAsset,
  ): string {
    return join(this.artifactDirectory(update), asset.name);
  }

  private artifactDirectory(update: CarThingAvailableUpdate): string {
    return join(this.stateDir, "artifacts", update.updateId);
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

  private async prepareArtifact(
    update: CarThingAvailableUpdate,
    asset: CarThingOtaAsset,
    onProgress?: (downloaded: number, total: number) => void | Promise<void>,
  ): Promise<void> {
    const artifactDirectory = this.artifactDirectory(update);
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const destination = this.assetPath(update, asset);
    if (await this.verifyFile(destination, asset.size, asset.sha256)) {
      await onProgress?.(asset.size, asset.size);
      return;
    }

    const partial = `${destination}.part`;
    await rm(partial, { force: true });
    const response = await this.fetchImpl(
      `${update.updateUrlBase.replace(/\/$/, "")}/${encodeURIComponent(asset.name)}`,
      {
        headers: { Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(30 * 60_000),
      },
    );
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`OTA asset ${asset.name} returned HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    let downloaded = 0;
    try {
      const file = await open(partial, "w", 0o600);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          downloaded += chunk.length;
          if (downloaded > asset.size) {
            throw new Error(
              `OTA asset ${asset.name} exceeded expected size ${asset.size}`,
            );
          }
          hasher.update(chunk);
          await writeAll(file, chunk);
          await onProgress?.(downloaded, asset.size);
        }
        await file.sync();
      } finally {
        await file.close();
      }

      const digest = hasher.digest("hex");
      if (downloaded !== asset.size) {
        throw new Error(
          `OTA asset ${asset.name} size mismatch: expected ${asset.size}, got ${downloaded}`,
        );
      }
      if (digest !== asset.sha256) {
        throw new Error(
          `OTA asset ${asset.name} hash mismatch: expected ${asset.sha256}, got ${digest}`,
        );
      }

      await replaceFile(partial, destination);
      await syncDirectory(artifactDirectory);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await rm(partial, { force: true });
      throw error;
    }
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
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error("OTA manifest contains duplicate asset names");
  }
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
  if (
    name.length > MAX_ASSET_NAME_LENGTH ||
    !ASSET_NAME_PATTERN.test(name) ||
    name.includes("..")
  ) {
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

function primaryAsset(update: CarThingAvailableUpdate): CarThingOtaAsset {
  return {
    name: update.primaryAsset,
    size: update.expectedSize,
    sha256: update.expectedSha256,
  };
}

function updateAssets(update: CarThingAvailableUpdate): CarThingOtaAsset[] {
  return [primaryAsset(update), ...update.rangeAssets];
}

function abortError(): Error {
  return new DOMException("The OTA range request was abandoned", "AbortError");
}

async function writeFileAtomically(path: string, bytes: Buffer): Promise<void> {
  const next = `${path}.next`;
  try {
    const file = await open(next, "w", 0o600);
    try {
      await writeAll(file, bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(next, { force: true });
    throw error;
  }
  await replaceFile(next, path);
  await syncDirectory(dirname(path));
}

async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await rm(destination, { force: true });
    await rename(source, destination);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await directory?.close();
  }
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
