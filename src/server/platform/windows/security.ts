import type { SessionProtector } from "../../services/auth-service";
import type { HostBridgeClient } from "../host-bridge";

interface ProtectedValue {
  value?: unknown;
}

export class WindowsSessionProtector implements SessionProtector {
  constructor(private readonly bridge: HostBridgeClient) {}

  async protect(value: string): Promise<string> {
    const response = await this.bridge.call<unknown>("security.protect", { value });
    if (!isProtectedValue(response)) {
      throw new Error("Windows host returned an invalid protected session");
    }
    return response.value;
  }

  async unprotect(value: string): Promise<string> {
    const response = await this.bridge.call<unknown>("security.unprotect", { value });
    if (!isProtectedValue(response)) {
      throw new Error("Windows host returned an invalid unprotected session");
    }
    return response.value;
  }
}

function isProtectedValue(value: unknown): value is ProtectedValue & { value: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as ProtectedValue).value === "string"
  );
}
