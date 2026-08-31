import { describe, expect, test } from "bun:test";
import { isSpotifySetupComplete } from "./SetupWizard";

describe("Spotify setup completion", () => {
  test("keeps Spotify mandatory on Pi and accepts skip only on Windows", () => {
    expect(isSpotifySetupComplete("linked")).toBeTrue();
    expect(isSpotifySetupComplete("skipped")).toBeFalse();
    expect(isSpotifySetupComplete("skipped", true)).toBeTrue();
  });

  test("rejects incomplete authorization states", () => {
    for (const status of [undefined, "idle", "loading", "polling"]) {
      expect(isSpotifySetupComplete(status)).toBeFalse();
    }
  });
});
