import { Elysia } from "elysia";
import type { OTAService } from "../services/ota-service";

function errorResponse(set: { status?: number | string }, status: number, error: string) {
  set.status = status;
  return { error };
}

export function createOtaRoutes(otaService: OTAService) {
  return new Elysia({ prefix: "/api/ota" })
    .get("/connector/status", () => otaService.getConnectorUpdateStatus())
    .post("/connector/check", async ({ body, set }) => {
      try {
        const b = (body as { channel?: string } | undefined) ?? {};
        return await otaService.checkConnectorUpdate(b.channel ?? "stable");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(set, 500, message);
      }
    })
    .post("/connector/start", async ({ body, set }) => {
      try {
        const b = (body as { channel?: string; targetVersion?: string } | undefined) ?? {};
        return await otaService.startConnectorUpdate({
          channel: b.channel,
          targetVersion: b.targetVersion,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("already in progress") ? 409 : 400;
        return errorResponse(set, status, message);
      }
    });
}
