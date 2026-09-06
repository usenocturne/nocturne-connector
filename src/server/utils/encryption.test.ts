import { describe, expect, test } from "bun:test";
import { createDecipheriv, pbkdf2Sync } from "crypto";
import { decrypt, encrypt } from "./encryption";

const userID = "a12bc345-678d-4e90-a123-abcdef123456";
const plaintext = "spotify-refresh-fixture";
const canonicalFixture = "AAECAwQFBgcICQoLAI3Wjhg7NhCa+Dx2LHXSmxELg3132N3BI6wgB7f7s++xfKSB0Hsk";
const legacyFixture = "AAECAwQFBgcICQoLvTSjKb6spYRwCMr+ABM4kWqTtWEF9zVdzGsYzKq23v4l+tutkMn5";

describe("shared Spotify credential encryption", () => {
  test("reads canonical Apple UUID keys through a lowercase Supabase identity", () => {
    expect(decrypt(canonicalFixture, userID)).toBe(plaintext);
  });

  test("retains older connector credentials with lowercase UUID keys", () => {
    expect(decrypt(legacyFixture, userID)).toBe(plaintext);
    expect(decrypt(legacyFixture, userID.toUpperCase())).toBe(plaintext);
  });

  test("keeps writes readable by released connectors using lowercase Supabase UUIDs", () => {
    const id = userID;
    const key = pbkdf2Sync(id, `com.usenocturne.Nocturne.encryption.v1${id}`, 100_000, 32, "sha256");
    const combined = Buffer.from(encrypt(plaintext, userID), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, combined.subarray(0, 12));
    decipher.setAuthTag(combined.subarray(-16));
    expect(Buffer.concat([
      decipher.update(combined.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8")).toBe(plaintext);
  });

  test("rejects other users and modified authentication tags", () => {
    expect(() => decrypt(canonicalFixture, "b12bc345-678d-4e90-a123-abcdef123456")).toThrow();
    const changed = Buffer.from(canonicalFixture, "base64");
    changed[changed.length - 1] ^= 1;
    expect(() => decrypt(changed.toString("base64"), userID)).toThrow();
  });
});
