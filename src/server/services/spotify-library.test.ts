import { describe, expect, test } from "bun:test";
import { SpotifyOperationHash } from "../config";
import { SpotifyDatabaseStorage } from "./spotify-database";
import { SpotifyService } from "./spotify-service";

interface PathfinderCall {
  operationName: string;
  hash: string;
  variables: Record<string, unknown>;
}

function serviceWithRecordedPathfinder(calls: PathfinderCall[]): SpotifyService {
  const service = new SpotifyService(new SpotifyDatabaseStorage(), () => "nocturne-user");
  service.performPathfinderRequest = async (operationName, hash, variables) => {
    calls.push({ operationName, hash, variables });
    if (operationName === "areEntitiesInLibrary") {
      return { data: { lookup: [{ data: { saved: true } }] } };
    }
    return {};
  };
  return service;
}

describe("Spotify library routing", () => {
  test("keeps ordinary track saves and removals on Pathfinder", async () => {
    const calls: PathfinderCall[] = [];
    const service = serviceWithRecordedPathfinder(calls);

    await service.handleSaveTracks({ ids: ["track-id", "spotify:track:track-uri"] });
    await service.handleRemoveTracks({ ids: ["track-id", "spotify:track:track-uri"] });

    expect(calls).toEqual([
      {
        operationName: "addToLibrary",
        hash: SpotifyOperationHash.addToLibrary,
        variables: {
          libraryItemUris: ["spotify:track:track-id", "spotify:track:track-uri"],
        },
      },
      {
        operationName: "removeFromLibrary",
        hash: SpotifyOperationHash.removeFromLibrary,
        variables: {
          libraryItemUris: ["spotify:track:track-id", "spotify:track:track-uri"],
        },
      },
    ]);
  });

  test("keeps local-file contains checks on the existing Pathfinder query", async () => {
    const calls: PathfinderCall[] = [];
    const service = serviceWithRecordedPathfinder(calls);
    const uri = "spotify:local:Artist:Album:Track:180";

    await expect(service.handleCheckSavedTracks({ ids: [uri] })).resolves.toEqual([true]);
    expect(calls).toEqual([
      {
        operationName: "areEntitiesInLibrary",
        hash: SpotifyOperationHash.areEntitiesInLibrary,
        variables: { uris: [uri] },
      },
    ]);
  });
});
