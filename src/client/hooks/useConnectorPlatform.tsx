import React, { createContext, useContext } from "react";

export type ConnectorPlatform = "linux" | "windows";

interface ConnectorPlatformState {
  platform: ConnectorPlatform;
  isWindows: boolean;
}

export function connectorPlatformForLocation(
  hostname: string,
  userAgent: string,
  search = "",
): ConnectorPlatform {
  const loopback = hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]";
  const explicitWindowsHost = new URLSearchParams(search)
    .get("connector-platform") === "windows";
  return loopback && explicitWindowsHost && /Windows/i.test(userAgent)
    ? "windows"
    : "linux";
}

function initialPlatform(): ConnectorPlatform {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "linux";
  }
  return connectorPlatformForLocation(
    window.location.hostname,
    navigator.userAgent,
    window.location.search,
  );
}

const initial = initialPlatform();
const ConnectorPlatformContext = createContext<ConnectorPlatformState>({
  platform: initial,
  isWindows: initial === "windows",
});

export function ConnectorPlatformProvider({
  children,
  platform = initial,
}: {
  children: React.ReactNode;
  platform?: ConnectorPlatform;
}) {
  return (
    <ConnectorPlatformContext.Provider
      value={{
        platform,
        isWindows: platform === "windows",
      }}
    >
      {children}
    </ConnectorPlatformContext.Provider>
  );
}

export function useConnectorPlatform(): ConnectorPlatformState {
  return useContext(ConnectorPlatformContext);
}
