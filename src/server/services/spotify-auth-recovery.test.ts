import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { SpotifyDatabaseStorage, type SpotifyDatabaseCredentials } from "./spotify-database";
import { SpotifyService } from "./spotify-service";

class MemoryCredentials extends SpotifyDatabaseStorage {
  deleted = 0;
  saved = 0;
  credentials: SpotifyDatabaseCredentials = {
    accessToken: "expired-access-token",
    refreshToken: "persisted-refresh-token",
    scope: null,
    tokenType: "Bearer",
    accessTokenExpiresAt: new Date(0),
  };

  override async loadCredentials(): Promise<SpotifyDatabaseCredentials> {
    return this.credentials;
  }

  override async saveCredentials(): Promise<void> {
    this.saved++;
  }

  override async deleteCredentials(): Promise<void> {
    this.deleted++;
  }
}

const services: SpotifyService[] = [];
const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
  for (const service of services.splice(0)) service.cancelAuthorization();
  fetchSpy.mockReset();
});

function createService() {
  const database = new MemoryCredentials();
  const service = new SpotifyService(database, () => "user-1", undefined, false);
  service.performPathfinderRequest = async () => ({ data: { me: { profile: { name: "Listener" } } } });
  services.push(service);
  return { database, service };
}

describe("Spotify startup recovery", () => {
  test("retains restored login on server failure, then recovers when online", async () => {
    const { database, service } = createService();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 503 }));
    await service.checkAuthStatus();
    expect(service.authState.status).toBe("linked");
    expect(database.deleted).toBe(0);
    expect(database.saved).toBe(0);

    fetchSpy.mockResolvedValueOnce(Response.json({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" }));
    await service.checkAuthStatus();
    expect(service.authState).toEqual({ status: "linked", displayName: "Listener" });
    expect(await service.getValidAccessToken()).toBe("fresh");
    expect(database.saved).toBe(1);
  });

  test("does not save malformed success responses or erase existing login", async () => {
    const { database, service } = createService();
    fetchSpy.mockResolvedValueOnce(Response.json({}));
    await service.checkAuthStatus();
    expect(service.authState.status).toBe("linked");
    expect(database.saved).toBe(0);
    expect(database.deleted).toBe(0);
  });

  test("returns to linking only for a confirmed OAuth rejection", async () => {
    const { database, service } = createService();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await service.checkAuthStatus();
    expect(service.authState.status).toBe("idle");
    expect(database.deleted).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
