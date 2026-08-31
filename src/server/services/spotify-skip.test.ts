import { describe, expect, test } from "bun:test";
import { createSpotifyRoutes } from "../routes/spotify";
import { SpotifyDatabaseStorage } from "./spotify-database";
import {
  SpotifyService,
  type SpotifySkipPreferenceStore,
} from "./spotify-service";

class MemorySkipPreferenceStore implements SpotifySkipPreferenceStore {
  readonly saved: boolean[] = [];

  constructor(private skipped = false) {}

  load(): boolean {
    return this.skipped;
  }

  save(skipped: boolean): void {
    this.skipped = skipped;
    this.saved.push(skipped);
  }
}

function service(store: SpotifySkipPreferenceStore): SpotifyService {
  return new SpotifyService(
    new SpotifyDatabaseStorage(),
    () => "user-1",
    store,
    true,
  );
}

describe("Spotify skip preference", () => {
  test("persists skip and restores it before credential probing", async () => {
    const store = new MemorySkipPreferenceStore();
    const first = service(store);
    first.skipSpotifyAuth();
    expect(store.saved).toEqual([true]);
    expect(first.authState).toEqual({ status: "skipped" });

    const restored = service(store);
    expect(restored.isSpotifySkipped).toBeTrue();
    expect(restored.authState).toEqual({ status: "skipped" });
    await restored.checkAuthStatus();
    expect(restored.authState).toEqual({ status: "skipped" });
    restored.cancelAuthorization();
    expect(restored.authState).toEqual({ status: "skipped" });
  });

  test("exposes skip through the Spotify API", async () => {
    const spotify = service(new MemorySkipPreferenceStore());
    const app = createSpotifyRoutes(spotify);
    const response = await app.handle(new Request("http://localhost/api/spotify/skip", {
      method: "POST",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      authState: { status: "skipped" },
    });

    const status = await app.handle(new Request("http://localhost/api/spotify/status"));
    expect(await status.json()).toEqual({ authState: { status: "skipped" } });
  });

  test("keeps Spotify mandatory on the Pi even if a stale skip preference exists", async () => {
    const store = new MemorySkipPreferenceStore(true);
    const spotify = new SpotifyService(
      new SpotifyDatabaseStorage(),
      () => "user-1",
      store,
      false,
    );
    expect(spotify.isSpotifySkipSupported).toBeFalse();
    expect(spotify.isSpotifySkipped).toBeFalse();
    expect(spotify.authState).toEqual({ status: "idle" });
    expect(() => spotify.skipSpotifyAuth()).toThrow("not supported");

    const response = await createSpotifyRoutes(spotify).handle(new Request(
      "http://localhost/api/spotify/skip",
      { method: "POST" },
    ));
    expect(response.status).toBe(404);
    expect(store.saved).toEqual([]);
  });
});
