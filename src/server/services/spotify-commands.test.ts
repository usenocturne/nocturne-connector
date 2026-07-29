import { describe, expect, test } from "bun:test";
import { normalizeSpotifyCommand } from "./spotify-commands";

const commandAliases = [
  ["spotify.artist.topTracks", "spotify.artist.top_tracks"],
  ["spotify.auth.getStatus", "spotify.auth.get_status"],
  ["spotify.me.recentlyPlayed", "spotify.me.recently_played"],
  ["spotify.me.topArtists", "spotify.me.top_artists"],
  ["spotify.me.topTracks", "spotify.me.top_tracks"],
  ["spotify.radio.topMix", "spotify.radio.top_mix"],
] as const;

describe("normalizeSpotifyCommand", () => {
  for (const [legacy, canonical] of commandAliases) {
    test(`normalizes ${legacy}`, () => {
      expect(normalizeSpotifyCommand(legacy)).toBe(canonical);
    });

    test(`preserves ${canonical}`, () => {
      expect(normalizeSpotifyCommand(canonical)).toBe(canonical);
    });
  }

  test("preserves unrelated commands", () => {
    expect(normalizeSpotifyCommand("spotify.player.state")).toBe(
      "spotify.player.state"
    );
  });
});
