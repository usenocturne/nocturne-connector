import { describe, expect, test } from "bun:test";
import {
  createSpotifyCollectionClientUpdateId,
  encodeSpotifyCollectionWriteRequest,
  SPOTIFY_COLLECTION_CONTENT_TYPE,
  splitSpotifyLibraryTrackReferences,
  writeSpotifyLocalTracks,
} from "./spotify-collection";

const goldenWrite = {
  username: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  uris: [
    "spotify:local:example+artist:example+album123:example+track:example+track:152",
  ],
  addedAt: 1_787_065_453,
  clientUpdateId: "0123456789abcdef",
};

const goldenSaveHex =
  "0a1c61616161616161616161616161616161616161616161616161616161" +
  "120a636f6c6c656374696f6e" +
  "1a550a4d73706f746966793a6c6f63616c3a6578616d706c652b6172746973743a6578616d706c652b616c62756d3132333a6578616d706c652b747261636b3a6578616d706c652b747261636b3a31353210ede891d406" +
  "221030313233343536373839616263646566";
const goldenRemoveHex =
  "0a1c61616161616161616161616161616161616161616161616161616161" +
  "120a636f6c6c656374696f6e" +
  "1a570a4d73706f746966793a6c6f63616c3a6578616d706c652b6172746973743a6578616d706c652b616c62756d3132333a6578616d706c652b747261636b3a6578616d706c652b747261636b3a31353210ede891d4061801" +
  "221030313233343536373839616263646566";

function fetchStub(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: (_url: string | URL) => undefined,
  });
}

describe("Spotify collection v2", () => {
  test("matches the captured local-file save protobuf shape byte for byte", () => {
    const payload = encodeSpotifyCollectionWriteRequest(goldenWrite);

    expect(payload.byteLength).toBe(147);
    expect(Buffer.from(payload).toString("hex")).toBe(goldenSaveHex);
  });

  test("encodes local-file removals with CollectionItem.is_removed", () => {
    const remove = encodeSpotifyCollectionWriteRequest({
      ...goldenWrite,
      isRemoved: true,
    });

    expect(remove.byteLength).toBe(149);
    expect(Buffer.from(remove).toString("hex")).toBe(goldenRemoveHex);
  });

  test("generates the 16-lowercase-hex client update id used by Spotify", () => {
    expect(createSpotifyCollectionClientUpdateId()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("separates local URIs without changing ordinary Spotify routing", () => {
    expect(splitSpotifyLibraryTrackReferences([
      goldenWrite.uris[0],
      "track-id",
      "spotify:track:track-uri",
    ])).toEqual({
      localUris: goldenWrite.uris,
      libraryItemUris: ["spotify:track:track-id", "spotify:track:track-uri"],
    });
  });

  test("posts the protobuf to the regional spclient with required headers", async () => {
    const capture: { request?: Request } = {};
    const fetchImpl = fetchStub(async (input, init) => {
      capture.request = new Request(input, init);
      return new Response(null, { status: 200 });
    });

    await writeSpotifyLocalTracks({
      ...goldenWrite,
      spclientEndpoint: "gue1-spclient.spotify.com",
      accessToken: "test-access-token",
      clientToken: "test-client-token",
      appPlatform: "WebPlayer",
      appVersion: "1.2.80.313.gd1726b65",
      userAgent: "Spotify test user agent",
      fetchImpl,
    });

    const request = capture.request;
    if (!request) throw new Error("Expected a collection request");
    expect(request.url).toBe(
      "https://gue1-spclient.spotify.com/collection/v2/write",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.get("accept")).toBe(SPOTIFY_COLLECTION_CONTENT_TYPE);
    expect(request.headers.get("accept-language")).toBe("en");
    expect(request.headers.get("app-platform")).toBe("WebPlayer");
    expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
    expect(request.headers.get("content-type")).toBe(SPOTIFY_COLLECTION_CONTENT_TYPE);
    expect(request.headers.get("spotify-app-version")).toBe(
      "1.2.80.313.gd1726b65",
    );
    expect(request.headers.get("user-agent")).toBe("Spotify test user agent");
    expect(request.headers.get("client-token")).toBe("test-client-token");
    expect(request.headers.get("origin")).toBe("https://gue1-spclient.spotify.com");
    expect(Buffer.from(await request.arrayBuffer()).toString("hex")).toBe(
      goldenSaveHex,
    );
  });

  test("surfaces collection write failures", async () => {
    await expect(writeSpotifyLocalTracks({
      ...goldenWrite,
      spclientEndpoint: "gue1-spclient.spotify.com",
      accessToken: "test-access-token",
      clientToken: "test-client-token",
      appPlatform: "WebPlayer",
      appVersion: "1.2.80.313.gd1726b65",
      userAgent: "Spotify test user agent",
      fetchImpl: fetchStub(async () => new Response(null, { status: 503 })),
    })).rejects.toThrow("Spotify collection write failed: HTTP 503");
  });
});
