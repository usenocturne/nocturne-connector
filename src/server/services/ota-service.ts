import { createHash } from "crypto";
import { once } from "events";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { CONNECTOR_RELEASES_API_URL, OTA_SERVER_URL } from "../config";
import { runShell } from "../utils/shell";
import { createLogger } from "../utils/logger";
import { getConnectorVersion } from "../utils/version";

const log = createLogger("OTAService");

export interface UpdateCheckResponse {
  updateAvailable: boolean;
  version: string | null;
  channel: string | null;
  metadata: { auto_updateable: boolean; critical: boolean } | null;
}

type ConnectorUpdateStage =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "flashing"
  | "ready"
  | "failed";

interface GitHubAsset {
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: GitHubAsset[];
}

export interface ConnectorUpdateCheckResponse {
  updateAvailable: boolean;
  currentVersion: string;
  version: string | null;
  channel: string;
  releaseUrl: string | null;
  imageUrl: string | null;
  checksumUrl: string | null;
  sha256: string | null;
  size: number | null;
  publishedAt: string | null;
  message?: string;
}

export interface ConnectorUpdateStatus {
  inProgress: boolean;
  stage: ConnectorUpdateStage;
  currentVersion: string;
  targetVersion: string | null;
  activeSlot: "A" | "B" | "unknown";
  inactiveSlot: "A" | "B" | "unknown";
  supported: boolean;
  rebootRequired: boolean;
  updateAvailable: boolean | null;
  availableVersion: string | null;
  bytesComplete: number | null;
  bytesTotal: number | null;
  percent: number | null;
  speedBytesPerSecond: number | null;
  error: string | null;
  updatedAt: string;
}

type ConnectorStatusListener = (status: ConnectorUpdateStatus) => void;

interface BootInfo {
  rootDevice: string | null;
  activePartition: 2 | 3 | null;
  activeSlot: "A" | "B" | "unknown";
  inactiveSlot: "A" | "B" | "unknown";
  supported: boolean;
}

function connectorStatusDefaults(): ConnectorUpdateStatus {
  const boot = readBootInfo();
  return {
    inProgress: false,
    stage: "idle",
    currentVersion: getConnectorVersion(),
    targetVersion: null,
    activeSlot: boot.activeSlot,
    inactiveSlot: boot.inactiveSlot,
    supported: boot.supported,
    rebootRequired: false,
    updateAvailable: null,
    availableVersion: null,
    bytesComplete: null,
    bytesTotal: null,
    percent: null,
    speedBytesPerSecond: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [main, suffix = ""] = stripVersionPrefix(version).split("-", 2);
    const parts = main.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const suffixWeight =
      suffix === "" ? 0 : /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : -1000;
    return { parts, suffixWeight, suffix };
  };

  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.parts.length, bv.parts.length); i++) {
    const diff = (av.parts[i] ?? 0) - (bv.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (av.suffixWeight !== bv.suffixWeight) {
    return av.suffixWeight - bv.suffixWeight;
  }
  return av.suffix.localeCompare(bv.suffix);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBootInfo(): BootInfo {
  let rootDevice: string | null = null;
  try {
    const rootArg = readFileSync("/proc/cmdline", "utf-8")
      .split(/\s+/)
      .find((part) => part.startsWith("root="));
    rootDevice = rootArg ? rootArg.slice("root=".length) : null;
  } catch {}

  const match = rootDevice?.match(/([23])$/);
  const activePartition = match ? (Number(match[1]) as 2 | 3) : null;
  const activeSlot = activePartition === 2 ? "A" : activePartition === 3 ? "B" : "unknown";
  const inactiveSlot = activePartition === 2 ? "B" : activePartition === 3 ? "A" : "unknown";

  return {
    rootDevice,
    activePartition,
    activeSlot,
    inactiveSlot,
    supported:
      activePartition !== null &&
      existsSync("/usr/sbin/uboot_tool") &&
      existsSync("/uboot"),
  };
}

function inactiveRootDevice(boot: BootInfo): string {
  if (!boot.rootDevice || !boot.activePartition) {
    throw new Error("Unable to determine active root partition");
  }
  const inactivePartition = boot.activePartition === 2 ? 3 : 2;
  return boot.rootDevice.replace(/[0-9]+$/, String(inactivePartition));
}

function gzipUncompressedSize(filePath: string): number | null {
  const stat = statSync(filePath);
  if (stat.size < 4) return null;

  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, stat.size - 4);
    return buf.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export class OTAService {
  private connectorStatus: ConnectorUpdateStatus = connectorStatusDefaults();
  private connectorStatusListener: ConnectorStatusListener | null = null;
  private lastConnectorCheck: ConnectorUpdateCheckResponse | null = null;

  setConnectorStatusListener(listener: ConnectorStatusListener | null): void {
    this.connectorStatusListener = listener;
  }

  async checkForUpdates(currentVersion: string, channel: string): Promise<UpdateCheckResponse> {
    const res = await fetch(`${OTA_SERVER_URL}/check-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentVersion, channel }),
    });

    if (!res.ok) throw new Error(`OTA server returned ${res.status}`);
    const data = await res.json();

    if (data.updateAvailable) {
      log.info(`Update available: ${data.version}`);
    } else {
      log.info("No updates available");
    }

    return data;
  }

  async downloadUpdate(currentVersion: string, targetVersion: string): Promise<string> {
    log.info(`Downloading update: ${currentVersion} -> ${targetVersion}`);

    const res = await fetch(`${OTA_SERVER_URL}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentVersion, targetVersion }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const buf = await res.arrayBuffer();
    const dir = "/tmp/nocturne-ota";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filePath = `${dir}/nocturne-update.swu`;
    writeFileSync(filePath, Buffer.from(buf));
    log.info(`Downloaded ${buf.byteLength} bytes to ${filePath}`);

    return filePath;
  }

  readChunk(filePath: string, offset: number, size: number): Buffer {
    if (!existsSync(filePath)) throw new Error("Update file not found");

    const stat = statSync(filePath);
    if (offset < 0 || offset >= stat.size) throw new Error(`Invalid offset: ${offset}`);

    const fd = openSync(filePath, "r");
    try {
      const bytesToRead = Math.min(size, stat.size - offset);
      const buf = Buffer.alloc(bytesToRead);
      readSync(fd, buf, 0, bytesToRead, offset);
      return buf;
    } finally {
      closeSync(fd);
    }
  }

  calculateMD5(filePath: string): string {
    if (!existsSync(filePath)) throw new Error("Update file not found");
    const data = readFileSync(filePath);
    return createHash("md5").update(data).digest("hex");
  }

  getConnectorUpdateStatus(): ConnectorUpdateStatus {
    const boot = readBootInfo();
    return {
      ...this.connectorStatus,
      currentVersion: getConnectorVersion(),
      activeSlot: boot.activeSlot,
      inactiveSlot: boot.inactiveSlot,
      supported: boot.supported,
    };
  }

  async checkConnectorUpdate(channel = "stable"): Promise<ConnectorUpdateCheckResponse> {
    this.updateConnectorStatus({
      stage: "checking",
      error: null,
      bytesComplete: null,
      bytesTotal: null,
      percent: null,
      speedBytesPerSecond: null,
    });

    const currentVersion = getConnectorVersion();
    const res = await fetch(`${CONNECTOR_RELEASES_API_URL}?per_page=30`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "nocturne-connector",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`GitHub releases returned ${res.status}`);

    const releases = (await res.json()) as GitHubRelease[];
    const candidates = releases
      .filter((release) => !release.draft)
      .filter((release) => channel !== "stable" || !release.prerelease)
      .filter((release) => compareVersions(release.tag_name, currentVersion) > 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

    for (const release of candidates) {
      const imageName = `nocturne-connector_${release.tag_name}_update.img.gz`;
      const image = release.assets.find((asset) => asset.name === imageName);
      const checksum = release.assets.find((asset) => asset.name === `${imageName}.sha256`);
      if (!image) continue;

      const digest = image.digest?.startsWith("sha256:")
        ? image.digest.slice("sha256:".length)
        : null;
      const result: ConnectorUpdateCheckResponse = {
        updateAvailable: true,
        currentVersion,
        version: release.tag_name,
        channel,
        releaseUrl: release.html_url,
        imageUrl: image.browser_download_url,
        checksumUrl: checksum?.browser_download_url ?? null,
        sha256: digest,
        size: image.size,
        publishedAt: release.published_at,
      };
      this.lastConnectorCheck = result;
      this.updateConnectorStatus({
        stage: "idle",
        updateAvailable: true,
        availableVersion: release.tag_name,
        targetVersion: release.tag_name,
      });
      return result;
    }

    const newest = candidates[0];
    const result: ConnectorUpdateCheckResponse = {
      updateAvailable: false,
      currentVersion,
      version: null,
      channel,
      releaseUrl: null,
      imageUrl: null,
      checksumUrl: null,
      sha256: null,
      size: null,
      publishedAt: null,
      message: newest
        ? `Release ${newest.tag_name} does not include a connector self-update package.`
        : "No connector updates available.",
    };
    this.lastConnectorCheck = result;
    this.updateConnectorStatus({
      stage: "idle",
      updateAvailable: false,
      availableVersion: null,
      targetVersion: null,
    });
    return result;
  }

  async startConnectorUpdate(options?: {
    channel?: string;
    targetVersion?: string;
  }): Promise<ConnectorUpdateStatus> {
    if (this.connectorStatus.inProgress) {
      throw new Error("Connector update already in progress");
    }

    const channel = options?.channel ?? this.lastConnectorCheck?.channel ?? "stable";
    let update = this.lastConnectorCheck;
    if (!update || (options?.targetVersion && update.version !== options.targetVersion)) {
      update = await this.checkConnectorUpdate(channel);
    }

    if (!update.updateAvailable || !update.version || !update.imageUrl) {
      throw new Error(update.message ?? "No connector update available");
    }

    if (!readBootInfo().supported) {
      throw new Error("Connector A/B boot is not available on this system");
    }

    void this.runConnectorUpdate(update).catch((err) => {
      const message = formatError(err);
      log.error(`Connector update failed: ${message}`);
      this.updateConnectorStatus({
        inProgress: false,
        stage: "failed",
        error: message,
      });
    });

    return this.getConnectorUpdateStatus();
  }

  private async runConnectorUpdate(update: ConnectorUpdateCheckResponse): Promise<void> {
    const boot = readBootInfo();
    if (!boot.supported) {
      throw new Error("Connector A/B boot is not available on this system");
    }

    const dir = "/tmp/nocturne-connector-ota";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = `${dir}/nocturne-connector-update.img.gz`;

    this.updateConnectorStatus({
      inProgress: true,
      stage: "downloading",
      currentVersion: update.currentVersion,
      targetVersion: update.version,
      updateAvailable: true,
      availableVersion: update.version,
      rebootRequired: false,
      error: null,
      bytesComplete: 0,
      bytesTotal: update.size,
      percent: 0,
      speedBytesPerSecond: null,
    });

    await this.downloadConnectorImage(update.imageUrl!, filePath, update.size);
    const expectedSha = await this.resolveExpectedSha(update);

    this.updateConnectorStatus({
      stage: "verifying",
      bytesComplete: null,
      bytesTotal: null,
      percent: null,
      speedBytesPerSecond: null,
    });

    const actualSha = await sha256File(filePath);
    if (expectedSha && actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new Error(`Update checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
    }

    await this.flashConnectorImage(filePath, boot);

    this.updateConnectorStatus({
      inProgress: false,
      stage: "ready",
      rebootRequired: true,
      bytesComplete: null,
      bytesTotal: null,
      percent: 100,
      speedBytesPerSecond: null,
      error: null,
    });
  }

  private async resolveExpectedSha(update: ConnectorUpdateCheckResponse): Promise<string | null> {
    if (update.sha256) return update.sha256;
    if (!update.checksumUrl) return null;

    const res = await fetch(update.checksumUrl, {
      headers: { "User-Agent": "nocturne-connector" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Checksum download failed: ${res.status}`);

    const text = await res.text();
    return text.trim().split(/\s+/)[0] ?? null;
  }

  private async downloadConnectorImage(
    url: string,
    filePath: string,
    expectedSize: number | null,
  ): Promise<void> {
    const res = await fetch(url, {
      headers: { "User-Agent": "nocturne-connector" },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw new Error(`Update download failed: ${res.status}`);
    if (!res.body) throw new Error("Update download returned an empty body");

    const headerSize = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    const total = expectedSize ?? (Number.isFinite(headerSize) ? headerSize : null);
    const reader = res.body.getReader();
    const out = createWriteStream(filePath);
    let complete = 0;
    let lastBytes = 0;
    let lastAt = Date.now();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = Buffer.from(value);
        complete += chunk.length;
        if (!out.write(chunk)) await once(out, "drain");

        const now = Date.now();
        if (now - lastAt >= 250) {
          const speed = ((complete - lastBytes) / (now - lastAt)) * 1000;
          this.updateConnectorStatus({
            bytesComplete: complete,
            bytesTotal: total,
            percent: total ? Math.round((complete / total) * 1000) / 10 : null,
            speedBytesPerSecond: Math.round(speed),
          });
          lastAt = now;
          lastBytes = complete;
        }
      }
    } finally {
      out.end();
    }

    await once(out, "finish");
    this.updateConnectorStatus({
      bytesComplete: complete,
      bytesTotal: total,
      percent: total ? 100 : null,
      speedBytesPerSecond: null,
    });
  }

  private async flashConnectorImage(filePath: string, boot: BootInfo): Promise<void> {
    const targetDevice = inactiveRootDevice(boot);
    const total = gzipUncompressedSize(filePath);
    let complete = 0;
    let lastBytes = 0;
    let lastAt = Date.now();

    this.updateConnectorStatus({
      stage: "flashing",
      bytesComplete: 0,
      bytesTotal: total,
      percent: 0,
      speedBytesPerSecond: null,
    });

    const progress = new Transform({
      transform: (
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null, data?: Buffer) => void,
      ) => {
        complete += chunk.length;
        const now = Date.now();
        if (now - lastAt >= 250) {
          const speed = ((complete - lastBytes) / (now - lastAt)) * 1000;
          this.updateConnectorStatus({
            bytesComplete: complete,
            bytesTotal: total,
            percent: total ? Math.round((complete / total) * 1000) / 10 : null,
            speedBytesPerSecond: Math.round(speed),
          });
          lastAt = now;
          lastBytes = complete;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      createReadStream(filePath),
      createGunzip(),
      progress,
      createWriteStream(targetDevice, { flags: "w" }),
    );

    await runShell("sync");
    await this.switchUbootToInactiveSlot(boot);

    this.updateConnectorStatus({
      bytesComplete: total,
      bytesTotal: total,
      percent: 100,
      speedBytesPerSecond: null,
    });
  }

  private async switchUbootToInactiveSlot(boot: BootInfo): Promise<void> {
    if (!boot.activePartition) throw new Error("Unable to determine active partition");

    const ubootPartition = Number((await runShell("/usr/sbin/uboot_tool part_current")).trim());
    if (ubootPartition !== boot.activePartition) {
      log.info("U-Boot already points at the inactive slot");
      return;
    }

    await runShell(
      "mount -o remount,rw /uboot && /usr/sbin/uboot_tool part_switch && sync && mount -o remount,ro /uboot",
    );
  }

  private updateConnectorStatus(patch: Partial<ConnectorUpdateStatus>): void {
    const boot = readBootInfo();
    this.connectorStatus = {
      ...this.connectorStatus,
      ...patch,
      currentVersion: patch.currentVersion ?? getConnectorVersion(),
      activeSlot: boot.activeSlot,
      inactiveSlot: boot.inactiveSlot,
      supported: boot.supported,
      updatedAt: new Date().toISOString(),
    };
    this.connectorStatusListener?.(this.connectorStatus);
  }
}
