import { HOST_PIPE_PATH, HOST_PIPE_TOKEN } from "../config";
import {
  BluetoothService,
  createUnavailableBluetoothService,
} from "../services/bluetooth-service";
import { HostBridge, type HostBridgeClient } from "./host-bridge";
import {
  WindowsBluetoothAdapter,
  WindowsPairingAgent,
  WindowsRFCOMMClient,
  WindowsRFCOMMServer,
} from "./windows/bluetooth";
import { WindowsSessionProtector } from "./windows/security";

export interface PlatformComposition {
  hostBridge: HostBridgeClient | null;
  bluetoothService: BluetoothService;
  sessionProtector: WindowsSessionProtector | null;
}

export interface PlatformCompositionOptions {
  platform?: NodeJS.Platform;
  hostPipePath?: string | null;
  hostPipeToken?: string | null;
  hostBridge?: HostBridgeClient;
}

export function createPlatformComposition(
  options: PlatformCompositionOptions = {},
): PlatformComposition {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "linux") {
    return {
      hostBridge: null,
      bluetoothService: createUnavailableBluetoothService(),
      sessionProtector: null,
    };
  }

  if (platform === "linux") {
    return {
      hostBridge: null,
      bluetoothService: new BluetoothService({ platform: "linux" }),
      sessionProtector: null,
    };
  }

  const bridge =
    options.hostBridge ??
    createWindowsHostBridge(
      options.hostPipePath ?? HOST_PIPE_PATH,
      options.hostPipeToken ?? HOST_PIPE_TOKEN,
    );
  return {
    hostBridge: bridge,
    bluetoothService: new BluetoothService({
      platform: "win32",
      adapter: new WindowsBluetoothAdapter(bridge),
      rfcommServer: new WindowsRFCOMMServer(bridge),
      rfcommClient: new WindowsRFCOMMClient(bridge),
      pairingAgent: new WindowsPairingAgent(bridge),
    }),
    sessionProtector: new WindowsSessionProtector(bridge),
  };
}

function createWindowsHostBridge(
  pipePath: string | null,
  token: string | null,
): HostBridge {
  if (!pipePath) {
    throw new Error("NOCTURNE_HOST_PIPE is required by the Windows connector backend");
  }
  if (!token) {
    throw new Error("NOCTURNE_HOST_TOKEN is required by the Windows connector backend");
  }
  return new HostBridge(pipePath, token);
}
