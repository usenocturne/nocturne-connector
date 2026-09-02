import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BluetoothDeviceList } from "./components/BluetoothDeviceList";
import { ConnectorPlatformProvider } from "./hooks/useConnectorPlatform";
import { SpotifyAuth } from "./pages/SpotifyAuth";

function renderPlatform(
  platform: "linux" | "windows",
  child: React.ReactNode,
): string {
  return renderToStaticMarkup(
    <ConnectorPlatformProvider platform={platform}>
      <MemoryRouter>{child}</MemoryRouter>
    </ConnectorPlatformProvider>,
  );
}

describe("shared connector UI platform isolation", () => {
  test("keeps the original Pi header spacing", () => {
    const linux = renderPlatform("linux", <Layout />);
    const windows = renderPlatform("windows", <Layout />);

    expect(linux).toContain(
      'class="mx-auto flex h-16 max-w-5xl items-center justify-between"',
    );
    expect(windows).toContain(
      'class="mx-auto flex h-16 max-w-5xl items-center justify-between px-6"',
    );
  });

  test("keeps Spotify mandatory and removes Windows copy on Pi", () => {
    const linux = renderPlatform("linux", <SpotifyAuth />);
    const windows = renderPlatform("windows", <SpotifyAuth />);

    expect(linux).not.toContain("Skip for now");
    expect(linux).not.toContain("Windows PC");
    expect(windows).toContain("Skip for now");
  });

  test("keeps one Windows device action pending through disconnect and unpair", () => {
    const markup = renderToStaticMarkup(
      <BluetoothDeviceList
        devices={[{
          address: "30:E3:D6:00:B5:5F",
          name: "Nocturne (Q01S)",
          paired: true,
          connected: false,
          trusted: true,
          rssi: -42,
        }]}
        onPair={() => {}}
        onUnpair={() => {}}
        onConnect={() => {}}
        busyAddress="30:E3:D6:00:B5:5F"
        busyAction="unpair"
      />,
    );

    expect(markup).toContain("Unpairing...");
    expect(markup).toContain("disabled");
  });

});
