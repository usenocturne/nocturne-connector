import { Elysia, t } from "elysia";
import type { SystemMediaService } from "../services/system-media-service";

export function createMediaRoutes(service: SystemMediaService | null) {
  if (!service) return new Elysia();

  const status = () => ({
    supported: true,
    enabled: service.isSystemMediaEnabled,
    forced: service.isForcedOn,
    active: service.isActive,
  });

  return new Elysia({ prefix: "/api/media" })
    .get("/status", status)
    .post(
      "/enabled",
      async ({ body }) => {
        await service.setSystemMediaEnabled(body.enabled);
        return status();
      },
      {
        body: t.Object({
          enabled: t.Boolean(),
        }),
      },
    );
}
