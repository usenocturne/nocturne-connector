import dgram from "node:dgram";
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createLogger } from "../utils/logger";

const log = createLogger("SpotifyZeroconf");

export const SPOTIFY_CONNECT_SERVICE = "_spotify-connect._tcp.local";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const BROWSE_WINDOW_MS = 1_500;
const HTTP_TIMEOUT_MS = 3_000;
const REFRESH_INTERVAL_MS = 10_000;
const DEVICE_TTL_MS = 60_000;
const ZEROCONF_VERSION = "2.7.1";
const STATUS_OK = 101;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

const DH_GENERATOR = 2n;
const DH_PRIME = BigInt(
  "0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff",
);
const AUTHENTICATION_SPOTIFY_TOKEN = 3;

export interface MdnsRecord {
  name: string;
  type: number;
  data: string | Buffer | { target: string; port: number } | Record<string, string>;
}

export interface MdnsService {
  instance: string;
  address: string;
  port: number;
  path: string;
}

export interface ZeroconfDevice {
  id: string;
  name: string;
  type: string;
  url: string;
  seenAt: number;
}

interface ZeroconfInfo {
  deviceID: string;
  remoteName: string;
  deviceType: string;
  publicKey: string;
  tokenType: string;
}

export type MdnsBrowser = (service: string, windowMs: number) => Promise<MdnsService[]>;

function encodeName(name: string): Buffer {
  const labels = name.split(".").filter(Boolean).map((label) => {
    const bytes = Buffer.from(label, "utf8");
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...labels, Buffer.from([0])]);
}

export function encodeMdnsQuery(questions: { name: string; type: number }[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  const body = questions.map(({ name, type }) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    return Buffer.concat([encodeName(name), tail]);
  });
  return Buffer.concat([header, ...body]);
}

function readName(packet: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  let jumps = 0;
  for (;;) {
    const length = packet[offset];
    if (length === undefined) throw new Error("Truncated DNS name");
    if (length === 0) {
      return { name: labels.join("."), next: next === -1 ? offset + 1 : next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (++jumps > 16) throw new Error("DNS name compression loop");
      if (next === -1) next = offset + 2;
      offset = packet.readUInt16BE(offset) & 0x3fff;
      continue;
    }
    if (offset + 1 + length > packet.length) throw new Error("Truncated DNS name");
    labels.push(packet.toString("utf8", offset + 1, offset + 1 + length));
    offset += length + 1;
  }
}

function readTxt(data: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset];
    const entry = data.toString("utf8", offset + 1, offset + 1 + length);
    offset += length + 1;
    const separator = entry.indexOf("=");
    if (separator > 0) entries[entry.slice(0, separator).toLowerCase()] = entry.slice(separator + 1);
  }
  return entries;
}

export function parseMdnsRecords(packet: Buffer): MdnsRecord[] {
  if (packet.length < 12) return [];
  const questions = packet.readUInt16BE(4);
  const records = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) offset = readName(packet, offset).next + 4;

  const parsed: MdnsRecord[] = [];
  for (let i = 0; i < records; i++) {
    const { name, next } = readName(packet, offset);
    const type = packet.readUInt16BE(next);
    const length = packet.readUInt16BE(next + 8);
    const dataStart = next + 10;
    const data = packet.subarray(dataStart, dataStart + length);
    if (data.length !== length) throw new Error("Truncated DNS record");
    offset = dataStart + length;

    if (type === TYPE_PTR) parsed.push({ name, type, data: readName(packet, dataStart).name });
    else if (type === TYPE_SRV) {
      parsed.push({ name, type, data: { port: data.readUInt16BE(4), target: readName(packet, dataStart + 6).name } });
    } else if (type === TYPE_TXT) parsed.push({ name, type, data: readTxt(data) });
    else if (type === TYPE_A && length === 4) parsed.push({ name, type, data: Array.from(data).join(".") });
  }
  return parsed;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class MdnsServiceCollector {
  private instances = new Map<string, string>();
  private srv = new Map<string, { target: string; port: number }>();
  private txt = new Map<string, Record<string, string>>();
  private addresses = new Map<string, string>();
  private requested = new Set<string>();

  constructor(private service: string) {}

  add(records: MdnsRecord[]): { name: string; type: number }[] {
    for (const record of records) {
      const key = record.name.toLowerCase();
      if (record.type === TYPE_PTR && sameName(record.name, this.service)) {
        const instance = record.data as string;
        this.instances.set(instance.toLowerCase(), instance);
      } else if (record.type === TYPE_SRV) {
        this.srv.set(key, record.data as { target: string; port: number });
      } else if (record.type === TYPE_TXT) {
        this.txt.set(key, record.data as Record<string, string>);
      } else if (record.type === TYPE_A) {
        this.addresses.set(key, record.data as string);
      }
    }
    return this.missing();
  }

  private missing(): { name: string; type: number }[] {
    const questions: { name: string; type: number }[] = [];
    const ask = (name: string, type: number) => {
      const key = `${type}:${name.toLowerCase()}`;
      if (this.requested.has(key)) return;
      this.requested.add(key);
      questions.push({ name, type });
    };
    for (const [key, instance] of this.instances) {
      const srv = this.srv.get(key);
      if (!srv) ask(instance, TYPE_SRV);
      else if (!this.addresses.has(srv.target.toLowerCase())) ask(srv.target, TYPE_A);
      if (!this.txt.has(key)) ask(instance, TYPE_TXT);
    }
    return questions;
  }

  services(): MdnsService[] {
    return [...this.instances].flatMap(([key, instance]) => {
      const srv = this.srv.get(key);
      const address = srv && this.addresses.get(srv.target.toLowerCase());
      if (!srv || !address) return [];
      const path = this.txt.get(key)?.cpath || "/";
      return [{ instance, address, port: srv.port, path: path.startsWith("/") ? path : `/${path}` }];
    });
  }
}

function openMdnsSocket(platform: NodeJS.Platform = process.platform): Promise<dgram.Socket> {
  const bind = (port: number, shared: boolean) =>
    new Promise<dgram.Socket>((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: shared });
      socket.once("error", (error) => {
        socket.close();
        reject(error);
      });
      socket.bind(port, () => {
        try {
          if (shared) {
            socket.addMembership(MDNS_ADDRESS);
            socket.setMulticastTTL(255);
          }
          resolve(socket);
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });

  if (platform === "win32") return bind(0, false);
  return bind(MDNS_PORT, true).catch((error) => {
    log.debug("Shared mDNS socket unavailable; using a legacy unicast query socket", error);
    return bind(0, false);
  });
}

export const browseMdns: MdnsBrowser = async (service, windowMs) => {
  const socket = await openMdnsSocket();
  const collector = new MdnsServiceCollector(service);
  const send = (questions: { name: string; type: number }[]) => {
    if (questions.length === 0) return;
    socket.send(encodeMdnsQuery(questions), MDNS_PORT, MDNS_ADDRESS, (error) => {
      if (error) log.debug("mDNS query send failed", error);
    });
  };

  socket.removeAllListeners("error");
  socket.on("error", (error) => log.debug("mDNS socket error", error));
  socket.on("message", (packet) => {
    try {
      send(collector.add(parseMdnsRecords(packet)));
    } catch (error) { log.debug("Ignoring malformed mDNS packet", error); }
  });

  send([{ name: service, type: TYPE_PTR }]);
  await Bun.sleep(windowMs);
  socket.close();
  return collector.services();
};

function bigIntFromBytes(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function bytesFromBigInt(value: bigint): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function blobInt(value: number): Buffer {
  return value < 0x80 ? Buffer.from([value]) : Buffer.from([(value & 0x7f) | 0x80, value >> 7]);
}

export function encryptCredentialsBlob(username: string, deviceId: string, accessToken: string): string {
  const user = Buffer.from(username, "utf8");
  const token = Buffer.from(accessToken, "utf8");
  const plain = Buffer.concat([
    Buffer.from([0x49]), blobInt(user.length), user,
    Buffer.from([0x50]), blobInt(AUTHENTICATION_SPOTIFY_TOKEN),
    Buffer.from([0x51]), blobInt(token.length), token,
  ]);
  const data = Buffer.alloc(Math.ceil(plain.length / 16) * 16);
  plain.copy(data);
  for (let i = 16; i < data.length; i++) data[i] ^= data[i - 16];

  const secret = createHash("sha1").update(deviceId).digest();
  const derived = pbkdf2Sync(secret, user, 0x100, 20, "sha1");
  const key = Buffer.concat([createHash("sha1").update(derived).digest(), Buffer.from([0, 0, 0, 20])]);
  const cipher = createCipheriv("aes-192-ecb", key, null).setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("base64");
}

export function encryptAddUserBlob(credentials: string, remotePublicKey: Buffer): { blob: string; clientKey: string } {
  const privateKey = bigIntFromBytes(randomBytes(95));
  const publicKey = bytesFromBigInt(modPow(DH_GENERATOR, privateKey, DH_PRIME));
  const shared = bytesFromBigInt(modPow(bigIntFromBytes(remotePublicKey), privateKey, DH_PRIME));

  const baseKey = createHash("sha1").update(shared).digest().subarray(0, 16);
  const checksumKey = createHmac("sha1", baseKey).update("checksum").digest();
  const encryptionKey = createHmac("sha1", baseKey).update("encryption").digest().subarray(0, 16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-ctr", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(credentials, "utf8"), cipher.final()]);
  const checksum = createHmac("sha1", checksumKey).update(encrypted).digest();
  return {
    blob: Buffer.concat([iv, encrypted, checksum]).toString("base64"),
    clientKey: publicKey.toString("base64"),
  };
}

export function buildAddUserParams(
  info: Pick<ZeroconfInfo, "deviceID" | "publicKey" | "tokenType">,
  accessToken: string,
  username: string,
  client: { deviceId: string; deviceName: string },
): URLSearchParams {
  const tokenType = info.tokenType || "default";
  let blob: string;
  let clientKey = "";
  if (tokenType === "accesstoken") {
    blob = accessToken;
  } else if (tokenType === "default") {
    const remoteKey = Buffer.from(info.publicKey ?? "", "base64");
    if (remoteKey.length === 0) throw new Error("Spotify Connect device did not advertise a public key");
    ({ blob, clientKey } = encryptAddUserBlob(
      encryptCredentialsBlob(username, info.deviceID, accessToken),
      remoteKey,
    ));
  } else {
    throw new Error(`Unsupported Spotify Connect token type: ${tokenType}`);
  }

  return new URLSearchParams({
    action: "addUser",
    userName: username,
    blob,
    clientKey,
    tokenType,
    loginId: randomBytes(16).toString("hex"),
    deviceName: client.deviceName,
    deviceId: client.deviceId,
    version: ZEROCONF_VERSION,
  });
}

function serviceUrl(service: MdnsService): string {
  return `http://${service.address}:${service.port}${service.path}`;
}

async function readZeroconfJson(response: Response): Promise<any> {
  if (!response.ok) throw new Error(`Spotify Connect device returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.status !== STATUS_OK) {
    throw new Error(`Spotify Connect device returned ${body?.statusString ?? body?.status ?? "an invalid response"}`);
  }
  return body;
}

export class SpotifyZeroconf {
  private devices = new Map<string, ZeroconfDevice>();
  private lastRefreshAt = 0;
  private inFlightRefresh: Promise<void> | null = null;
  private readonly clientDeviceId = randomBytes(20).toString("hex");

  constructor(
    private readonly browse: MdnsBrowser = browseMdns,
    private readonly now: () => number = Date.now,
  ) {}

  refresh(): Promise<void> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    if (this.now() - this.lastRefreshAt < REFRESH_INTERVAL_MS) return Promise.resolve();
    this.lastRefreshAt = this.now();
    this.inFlightRefresh = this.discover()
      .catch((error) => log.debug("Spotify Connect discovery failed", error))
      .finally(() => { this.inFlightRefresh = null; });
    return this.inFlightRefresh;
  }

  list(): ZeroconfDevice[] {
    const cutoff = this.now() - DEVICE_TTL_MS;
    return [...this.devices.values()].filter((device) => device.seenAt >= cutoff);
  }

  get(id: string): ZeroconfDevice | undefined {
    return this.list().find((device) => device.id === id);
  }

  async activate(id: string, accessToken: string, username: string): Promise<void> {
    const device = this.get(id);
    if (!device) throw new Error("Spotify Connect device is no longer on the network");
    const info = await this.getInfo(device.url);
    const response = await fetch(device.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildAddUserParams(info, accessToken, username, {
        deviceId: this.clientDeviceId,
        deviceName: "Nocturne",
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await readZeroconfJson(response);
    log.info(`Signed Spotify Connect device "${device.name}" in over zeroconf`);
  }

  private async getInfo(url: string): Promise<ZeroconfInfo> {
    const query = new URLSearchParams({ action: "getInfo", version: ZEROCONF_VERSION });
    const response = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const info = await readZeroconfJson(response);
    if (typeof info.deviceID !== "string" || info.deviceID.length === 0) {
      throw new Error("Spotify Connect device did not report a device ID");
    }
    return info;
  }

  private async discover(): Promise<void> {
    const services = await this.browse(SPOTIFY_CONNECT_SERVICE, BROWSE_WINDOW_MS);
    const seenAt = this.now();
    const results = await Promise.allSettled(services.map(async (service) => {
      const url = serviceUrl(service);
      const info = await this.getInfo(url);
      return {
        id: info.deviceID,
        name: info.remoteName || service.instance.split(".")[0],
        type: info.deviceType || "Speaker",
        url,
        seenAt,
      } satisfies ZeroconfDevice;
    }));
    const cutoff = seenAt - DEVICE_TTL_MS;
    for (const [id, device] of this.devices) {
      if (device.seenAt < cutoff) this.devices.delete(id);
    }
    for (const result of results) {
      if (result.status === "fulfilled") this.devices.set(result.value.id, result.value);
      else log.debug("Spotify Connect getInfo failed", result.reason);
    }
  }
}
