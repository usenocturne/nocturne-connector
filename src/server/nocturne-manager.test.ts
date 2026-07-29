import { describe, expect, test } from "bun:test";
import {
  carThingOtaRequestParams,
  carThingOtaRequestVersions,
} from "./nocturne-manager";

describe("Car Thing OTA request parameters", () => {
  test("parses camel-case version lanes and install target", () => {
    expect(
      carThingOtaRequestParams({
        currentVersion: "4.3.1",
        imageVersion: "4.2.0",
        bandaidVersion: "4.3.1",
        channel: "beta",
        targetVersion: "4.4.0",
        targetKind: "image",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
      channel: "beta",
      targetVersion: "4.4.0",
      targetKind: "image",
    });
  });

  test("parses snake-case lanes and rejects an unknown target kind", () => {
    expect(
      carThingOtaRequestParams({
        current_version: "4.3.1",
        image_version: "4.2.0",
        bandaid_version: "4.3.1",
        target_version: "4.4.0",
        target_kind: "unsupported",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
      channel: "stable",
      targetVersion: "4.4.0",
      targetKind: null,
    });
  });

  test("uses cached snake-case device info when the request has no snapshot", () => {
    const params = carThingOtaRequestParams({ channel: "stable" });

    expect(
      carThingOtaRequestVersions(params, {
        version: "4.3.1",
        image_version: "4.2.0",
        bandaid_version: "4.3.1",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
    });
  });

  test("keeps an explicit request snapshot independent of cached device info", () => {
    const params = carThingOtaRequestParams({
      currentVersion: "4.1.0",
      imageVersion: "4.0.0",
      bandaidVersion: "4.1.0",
    });

    expect(
      carThingOtaRequestVersions(params, {
        version: "5.0.0",
        imageVersion: "5.0.0",
        bandaidVersion: "5.0.0",
      }),
    ).toEqual({
      currentVersion: "4.1.0",
      imageVersion: "4.0.0",
      bandaidVersion: "4.1.0",
    });
  });

  test("fills omitted request lanes from cached device info", () => {
    const params = carThingOtaRequestParams({ currentVersion: "4.3.1" });

    expect(
      carThingOtaRequestVersions(params, {
        version: "4.3.0",
        imageVersion: "4.2.0",
        bandaidVersion: "4.3.1",
      }),
    ).toEqual({
      currentVersion: "4.3.1",
      imageVersion: "4.2.0",
      bandaidVersion: "4.3.1",
    });
  });

  test("falls missing request and cached lanes back to current", () => {
    const params = carThingOtaRequestParams({ currentVersion: "4.1.0" });

    expect(carThingOtaRequestVersions(params, { version: "4.0.0" })).toEqual({
      currentVersion: "4.1.0",
      imageVersion: "4.1.0",
      bandaidVersion: "4.1.0",
    });
  });
});
