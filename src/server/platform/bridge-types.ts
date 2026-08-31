// Generated from windows/src-tauri/src/bridge.rs by windows/scripts/generate-bridge-types.ts.

export interface HostBridgeRequest {
  type: "request";
  id: number;
  token: string;
  generation: number;
  method: string;
  params: unknown;
}

export interface HostBridgeResponse {
  type: "response";
  id: number;
  generation: number;
  result?: unknown;
  error?: HostBridgeErrorPayload;
}

export interface HostBridgeErrorPayload {
  code: string;
  message: string;
}

export interface HostBridgeEvent {
  type: "event";
  topic: string;
  data: unknown;
  generation: number;
}
