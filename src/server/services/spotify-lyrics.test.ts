import { describe, expect, test } from "bun:test";
import {
  buildLrcLibUrl,
  LRCLIB_USER_AGENT,
  normalizeLyricsRequest,
  shouldUseSpotifyColorLyrics,
} from "./spotify-service";

describe("Spotify lyrics lookup", () => {
  test("builds LRCLIB requests with only title and artist", () => {
    const url = new URL(buildLrcLibUrl("Song & Dance", "Artist"));

    expect(url.searchParams.get("track_name")).toBe("Song & Dance");
    expect(url.searchParams.get("artist_name")).toBe("Artist");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "artist_name",
      "track_name",
    ]);
  });

  test("uses a conventional unbranded browser user agent", () => {
    expect(LRCLIB_USER_AGENT.startsWith("Mozilla/5.0 ")).toBe(true);
    expect(LRCLIB_USER_AGENT.toLowerCase()).not.toContain("nocturne");
  });

  test("bypasses Spotify lyrics for metadata-only and local-file requests", () => {
    expect(shouldUseSpotifyColorLyrics(undefined)).toBe(false);
    expect(shouldUseSpotifyColorLyrics("   ")).toBe(false);
    expect(shouldUseSpotifyColorLyrics("spotify:local:Artist:Album:Song:200")).toBe(false);
    expect(shouldUseSpotifyColorLyrics("SPOTIFY:LOCAL:Artist:Album:Song:200")).toBe(false);
    expect(shouldUseSpotifyColorLyrics("spotify:track:abc123")).toBe(true);
    expect(shouldUseSpotifyColorLyrics("abc123")).toBe(true);
  });

  test("accepts legacy request aliases without forwarding album or duration", () => {
    expect(normalizeLyricsRequest({
      contentId: " spotify:track:abc123 ",
      trackName: " Song & Dance ",
      artistName: " Artist ",
      albumName: "Ignored Album",
      durationMs: 203_250,
    })).toEqual({
      contentId: "spotify:track:abc123",
      trackName: "Song & Dance",
      artistName: "Artist",
    });
  });
});
