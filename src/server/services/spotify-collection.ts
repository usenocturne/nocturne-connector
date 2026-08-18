export const SPOTIFY_COLLECTION_CONTENT_TYPE =
  "application/vnd.collection-v2.spotify.proto";
type FetchLike = typeof fetch;

export interface SpotifyCollectionWriteRequest {
  username: string;
  uris: string[];
  addedAt: number | bigint;
  clientUpdateId: string;
  isRemoved?: boolean;
}

export interface SpotifyCollectionWriteOptions
  extends SpotifyCollectionWriteRequest {
  spclientEndpoint: string;
  accessToken: string;
  clientToken: string;
  appPlatform: string;
  appVersion: string;
  userAgent: string;
  fetchImpl?: FetchLike;
}

export interface SpotifyLibraryTrackReferences {
  localUris: string[];
  libraryItemUris: string[];
}

const encoder = new TextEncoder();
const CLIENT_UPDATE_ID_PATTERN = /^[0-9a-f]{16}$/;
const SPCLIENT_ENDPOINT_PATTERN = /^[a-z0-9.-]+(?::\d+)?$/i;

function concatenate(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function encodeVarint(value: number | bigint): Uint8Array {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid protobuf varint: ${value}`);
  }
  if (typeof value === "bigint" && value < 0n) {
    throw new Error(`Invalid protobuf varint: ${value}`);
  }

  const bytes: number[] = [];
  let remaining = typeof value === "bigint" ? value : BigInt(value);
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Uint8Array.from(bytes);
}

function encodeLengthDelimited(field: number, value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return concatenate([
    encodeVarint((field << 3) | 2),
    encodeVarint(bytes.byteLength),
    bytes,
  ]);
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

export function isSpotifyLocalUri(value: string): boolean {
  return value.toLowerCase().startsWith("spotify:local:");
}

export function createSpotifyCollectionClientUpdateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function splitSpotifyLibraryTrackReferences(
  ids: string[],
): SpotifyLibraryTrackReferences {
  const localUris: string[] = [];
  const libraryItemUris: string[] = [];

  for (const id of ids) {
    if (isSpotifyLocalUri(id)) {
      localUris.push(id);
    } else {
      libraryItemUris.push(
        id.startsWith("spotify:") ? id : `spotify:track:${id}`,
      );
    }
  }

  return { localUris, libraryItemUris };
}

export function encodeSpotifyCollectionWriteRequest(
  request: SpotifyCollectionWriteRequest,
): Uint8Array {
  requireNonEmpty(request.username, "Spotify username");
  if (request.uris.length === 0) throw new Error("At least one local URI is required");
  const addedAt = typeof request.addedAt === "bigint"
    ? request.addedAt
    : Number.isSafeInteger(request.addedAt)
      ? BigInt(request.addedAt)
      : -1n;
  if (addedAt < 0n || addedAt > 0x7fff_ffff_ffff_ffffn) {
    throw new Error(`Invalid collection added_at: ${request.addedAt}`);
  }
  if (!CLIENT_UPDATE_ID_PATTERN.test(request.clientUpdateId)) {
    throw new Error("Collection client_update_id must be 16 lowercase hexadecimal characters");
  }

  const items = request.uris.map((uri) => {
    if (!isSpotifyLocalUri(uri)) throw new Error(`Not a Spotify local URI: ${uri}`);
    const item = concatenate([
      encodeLengthDelimited(1, uri),
      concatenate([encodeVarint(2 << 3), encodeVarint(addedAt)]),
      ...(request.isRemoved
        ? [concatenate([encodeVarint(3 << 3), encodeVarint(1)])]
        : []),
    ]);
    return encodeLengthDelimited(3, item);
  });

  return concatenate([
    encodeLengthDelimited(1, request.username),
    encodeLengthDelimited(2, "collection"),
    ...items,
    encodeLengthDelimited(4, request.clientUpdateId),
  ]);
}

export async function writeSpotifyLocalTracks(
  options: SpotifyCollectionWriteOptions,
): Promise<void> {
  requireNonEmpty(options.accessToken, "Spotify access token");
  requireNonEmpty(options.clientToken, "Spotify client token");
  requireNonEmpty(options.appPlatform, "Spotify app platform");
  requireNonEmpty(options.appVersion, "Spotify app version");
  requireNonEmpty(options.userAgent, "Spotify user agent");
  if (!SPCLIENT_ENDPOINT_PATTERN.test(options.spclientEndpoint)) {
    throw new Error(`Invalid Spotify spclient endpoint: ${options.spclientEndpoint}`);
  }

  const origin = `https://${options.spclientEndpoint}`;
  const payload = encodeSpotifyCollectionWriteRequest(options);
  const body = new ArrayBuffer(payload.byteLength);
  new Uint8Array(body).set(payload);
  const response = await (options.fetchImpl ?? fetch)(
    `${origin}/collection/v2/write`,
    {
      method: "POST",
      headers: {
        Accept: SPOTIFY_COLLECTION_CONTENT_TYPE,
        "Accept-Language": "en",
        "App-Platform": options.appPlatform,
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": SPOTIFY_COLLECTION_CONTENT_TYPE,
        "Spotify-App-Version": options.appVersion,
        "User-Agent": options.userAgent,
        "client-token": options.clientToken,
        Origin: origin,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Spotify collection write failed: HTTP ${response.status}`);
  }
}
