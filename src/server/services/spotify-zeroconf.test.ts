import { afterEach, describe, expect, test } from "bun:test";
import { createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { SpotifyDatabaseStorage } from "./spotify-database";
import { SpotifyService } from "./spotify-service";
import {
  MdnsServiceCollector,
  SPOTIFY_CONNECT_SERVICE,
  SpotifyZeroconf,
  buildAddUserParams,
  encryptAddUserBlob,
  encryptCredentialsBlob,
  parseMdnsRecords,
  type MdnsService,
} from "./spotify-zeroconf";

const LIBRESPOT_REPLY = Buffer.from(
  "000084000001000100000004105f73706f746966792d636f6e6e656374045f746370056c6f63616c00000c8001c00c000c00010000000a00110e5370696b6520536f756e64626172c00cc039002100010000000a001a00000000a112114e65656c732d4d6163426f6f6b2d50726fc022c039001000010000000a00140b56455253494f4e3d312e300743506174683d2fc05c001c00010000000a0010fe800000000000001c9b799b57b1489cc05c000100010000000a0004c0a80181",
  "hex",
);

const DH_PRIME = BigInt(
  "0xffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff",
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  base %= DH_PRIME;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % DH_PRIME;
    exponent >>= 1n;
    base = (base * base) % DH_PRIME;
  }
  return result;
}

const toBigInt = (bytes: Buffer) => BigInt(`0x${bytes.toString("hex")}`);
const toBytes = (value: bigint) => {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
};

function librespotDecryptOuter(blob: string, clientKey: string, devicePrivateKey: bigint): string {
  const encrypted = Buffer.from(blob, "base64");
  const shared = toBytes(modPow(toBigInt(Buffer.from(clientKey, "base64")), devicePrivateKey));
  const baseKey = createHash("sha1").update(shared).digest().subarray(0, 16);
  const checksumKey = createHmac("sha1", baseKey).update("checksum").digest();
  const encryptionKey = createHmac("sha1", baseKey).update("encryption").digest().subarray(0, 16);
  const iv = encrypted.subarray(0, 16);
  const body = encrypted.subarray(16, encrypted.length - 20);
  const checksum = encrypted.subarray(encrypted.length - 20);
  expect(createHmac("sha1", checksumKey).update(body).digest().equals(checksum)).toBe(true);
  const decipher = createDecipheriv("aes-128-ctr", encryptionKey, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function librespotDecryptCredentials(credentials: string, username: string, deviceId: string) {
  const secret = createHash("sha1").update(deviceId).digest();
  const derived = pbkdf2Sync(secret, username, 0x100, 20, "sha1");
  const key = Buffer.concat([createHash("sha1").update(derived).digest(), Buffer.from([0, 0, 0, 20])]);
  const decipher = createDecipheriv("aes-192-ecb", key, null).setAutoPadding(false);
  const data = Buffer.concat([decipher.update(Buffer.from(credentials, "base64")), decipher.final()]);
  for (let i = 0; i < data.length - 0x10; i++) data[data.length - i - 1] ^= data[data.length - i - 0x11];

  let offset = 0;
  const readInt = () => {
    const low = data[offset++];
    if ((low & 0x80) === 0) return low;
    return (low & 0x7f) | (data[offset++] << 7);
  };
  const readBytes = () => {
    const length = readInt();
    const value = data.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  offset++;
  const user = readBytes().toString("utf8");
  offset++;
  const authType = readInt();
  offset++;
  const authData = readBytes().toString("utf8");
  return { user, authType, authData };
}

describe("mDNS parsing", () => {
  test("resolves a librespot legacy unicast reply into a service", () => {
    const collector = new MdnsServiceCollector(SPOTIFY_CONNECT_SERVICE);
    expect(collector.add(parseMdnsRecords(LIBRESPOT_REPLY))).toEqual([]);
    expect(collector.services()).toEqual([{
      instance: "Spike Soundbar._spotify-connect._tcp.local",
      address: "192.168.1.129",
      port: 41234,
      path: "/",
    }]);
  });

  test("asks for missing SRV, TXT, and address records once", () => {
    const collector = new MdnsServiceCollector(SPOTIFY_CONNECT_SERVICE);
    const ptrOnly = parseMdnsRecords(LIBRESPOT_REPLY).filter((record) => record.type === 12);
    expect(collector.add(ptrOnly)).toEqual([
      { name: "Spike Soundbar._spotify-connect._tcp.local", type: 33 },
      { name: "Spike Soundbar._spotify-connect._tcp.local", type: 16 },
    ]);
    expect(collector.add(ptrOnly)).toEqual([]);
    expect(collector.services()).toEqual([]);
  });

  test("rejects compression pointer loops", () => {
    const packet = Buffer.from("000084000000000100000000c00c000c0001000000000000", "hex");
    expect(() => parseMdnsRecords(packet)).toThrow("compression loop");
  });
});

describe("zeroconf addUser blobs", () => {
  test("produce credentials librespot decrypts into an access token login", () => {
    const devicePrivateKey = toBigInt(randomBytes(95));
    const devicePublicKey = toBytes(modPow(2n, devicePrivateKey));
    const token = `BQ${"x".repeat(300)}`;
    const deviceId = "f22021a1bd0b18b40a22fffd8dcc056b79e07d53";

    const credentials = encryptCredentialsBlob("31bambeenqo2diqbp6waurv4y5de", deviceId, token);
    const { blob, clientKey } = encryptAddUserBlob(credentials, devicePublicKey);

    expect(librespotDecryptOuter(blob, clientKey, devicePrivateKey)).toBe(credentials);
    expect(librespotDecryptCredentials(credentials, "31bambeenqo2diqbp6waurv4y5de", deviceId)).toEqual({
      user: "31bambeenqo2diqbp6waurv4y5de",
      authType: 3,
      authData: token,
    });
  });

  test("sends the raw token to accesstoken devices", () => {
    const params = buildAddUserParams(
      { deviceID: "device", publicKey: "", tokenType: "accesstoken" },
      "access-token",
      "user",
      { deviceId: "client", deviceName: "Nocturne" },
    );
    expect(params.get("action")).toBe("addUser");
    expect(params.get("blob")).toBe("access-token");
    expect(params.get("clientKey")).toBe("");
    expect(params.get("tokenType")).toBe("accesstoken");
    expect(params.get("deviceName")).toBe("Nocturne");
  });

  test("encrypts for default devices and rejects unknown token types", () => {
    const publicKey = toBytes(modPow(2n, 12345n)).toString("base64");
    const params = buildAddUserParams(
      { deviceID: "device", publicKey, tokenType: "" },
      "access-token",
      "user",
      { deviceId: "client", deviceName: "Nocturne" },
    );
    expect(params.get("tokenType")).toBe("default");
    expect(params.get("blob")).not.toBe("access-token");
    expect(params.get("clientKey")?.length).toBeGreaterThan(0);

    expect(() => buildAddUserParams(
      { deviceID: "device", publicKey, tokenType: "authorization_code" },
      "access-token",
      "user",
      { deviceId: "client", deviceName: "Nocturne" },
    )).toThrow("Unsupported");
  });
});

const SPEAKER: MdnsService = {
  instance: "Soundbar._spotify-connect._tcp.local",
  address: "192.168.1.50",
  port: 8080,
  path: "/zc",
};

function speakerInfo(overrides: Record<string, unknown> = {}) {
  return {
    status: 101,
    deviceID: "soundbar-id",
    remoteName: "Living Room",
    deviceType: "AVR",
    publicKey: "",
    tokenType: "accesstoken",
    ...overrides,
  };
}

describe("SpotifyZeroconf discovery", () => {
  test("lists devices that answer getInfo and throttles rediscovery", async () => {
    let browses = 0;
    const requested: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json(speakerInfo());
    }, { preconnect: (_url: string | URL) => undefined });

    const zeroconf = new SpotifyZeroconf(async () => {
      browses++;
      return [SPEAKER];
    });
    await zeroconf.refresh();
    await zeroconf.refresh();

    expect(browses).toBe(1);
    expect(requested).toEqual(["http://192.168.1.50:8080/zc?action=getInfo&version=2.7.1"]);
    expect(zeroconf.list()).toMatchObject([
      { id: "soundbar-id", name: "Living Room", type: "AVR", url: "http://192.168.1.50:8080/zc" },
    ]);
  });

  test("expires devices that stop answering", async () => {
    let now = 0;
    globalThis.fetch = Object.assign(async () => Response.json(speakerInfo()), {
      preconnect: (_url: string | URL) => undefined,
    });
    const zeroconf = new SpotifyZeroconf(async () => [SPEAKER], () => now);
    await zeroconf.refresh();
    now = 61_000;
    expect(zeroconf.get("soundbar-id")).toBeUndefined();
  });

  test("never rejects when browsing fails", async () => {
    const zeroconf = new SpotifyZeroconf(async () => {
      throw new Error("no multicast");
    });
    await expect(zeroconf.refresh()).resolves.toBeUndefined();
    expect(zeroconf.list()).toEqual([]);
  });
});

function connectState(devices: Record<string, unknown>) {
  return Response.json({ devices });
}

async function discoveredService(): Promise<SpotifyService> {
  const service = new SpotifyService(new SpotifyDatabaseStorage(), () => "nocturne-user");
  service.getValidAccessToken = async () => "access-token";
  (service as unknown as { getSpotifyUserId: () => Promise<string> }).getSpotifyUserId =
    async () => "spotify-user";
  globalThis.fetch = Object.assign(async () => Response.json(speakerInfo()), {
    preconnect: (_url: string | URL) => undefined,
  });
  service.zeroconf = new SpotifyZeroconf(async () => [SPEAKER]);
  await service.zeroconf.refresh();
  return service;
}

describe("SpotifyService local Connect devices", () => {
  test("merges discovered devices that are missing from the cloud cluster", async () => {
    const service = await discoveredService();
    globalThis.fetch = Object.assign(async () => connectState({
      phone: { name: "Phone", device_type: "SMARTPHONE" },
    }), { preconnect: (_url: string | URL) => undefined });

    const result = await service.handleListDevices();

    expect(result.devices).toEqual({
      phone: { name: "Phone", device_type: "SMARTPHONE" },
      "soundbar-id": { device_id: "soundbar-id", name: "Living Room", device_type: "AVR", is_active: false },
    });
  });

  test("prefers the cloud entry when the device is already signed in", async () => {
    const service = await discoveredService();
    globalThis.fetch = Object.assign(async () => connectState({
      "soundbar-id": { name: "Living Room", device_type: "AVR", is_active: true },
    }), { preconnect: (_url: string | URL) => undefined });

    const result = await service.handleListDevices();

    expect(result.devices["soundbar-id"].is_active).toBe(true);
  });

  test("signs a discovered device in before transferring playback to it", async () => {
    const service = await discoveredService();
    const calls: string[] = [];
    let signedIn = false;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://192.168.1.50")) {
        if (init?.method === "POST") {
          const body = new URLSearchParams(String(init.body));
          calls.push(`addUser:${body.get("tokenType")}:${body.get("blob")}:${body.get("userName")}`);
          signedIn = true;
          return Response.json({ status: 101, spotifyError: 0, statusString: "OK" });
        }
        calls.push("getInfo");
        return Response.json(speakerInfo());
      }
      if (url.includes("/connect-state/v1/devices/")) {
        calls.push("cluster");
        return connectState(signedIn ? { "soundbar-id": { name: "Living Room" } } : {});
      }
      if (url.includes("/connect/transfer/")) {
        calls.push(`transfer:${url.split("/").pop()}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    }, { preconnect: (_url: string | URL) => undefined });

    await expect(service.handleTransferPlayback({ device_ids: ["soundbar-id"], play: true }))
      .resolves.toEqual({ success: true });

    expect(calls).toEqual([
      "cluster",
      "getInfo",
      "addUser:accesstoken:access-token:spotify-user",
      "cluster",
      "transfer:soundbar-id",
    ]);
  });

  test("skips sign-in when the discovered device is already in the cluster", async () => {
    const service = await discoveredService();
    const calls: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/connect-state/v1/devices/")) {
        calls.push("cluster");
        return connectState({ "soundbar-id": { name: "Living Room" } });
      }
      if (url.includes("/connect/transfer/")) {
        calls.push("transfer");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    }, { preconnect: (_url: string | URL) => undefined });

    await service.handleTransferPlayback({ device_ids: ["soundbar-id"], play: true });

    expect(calls).toEqual(["cluster", "transfer"]);
  });

  test("fails the transfer when the device rejects sign-in", async () => {
    const service = await discoveredService();
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/connect-state/v1/devices/")) return connectState({});
      if (init?.method === "POST") return Response.json({ status: 102, statusString: "ERROR-MAC" });
      return Response.json(speakerInfo());
    }, { preconnect: (_url: string | URL) => undefined });

    await expect(service.handleTransferPlayback({ device_ids: ["soundbar-id"], play: true }))
      .rejects.toThrow("ERROR-MAC");
  });
});
