import type { Express, Request, Response, NextFunction } from "express";
import { getGatewayServices } from "../services/gateway.js";

const SAFE_NAMESPACE = /^[a-zA-Z0-9_-]+$/;

/**
 * Mutating runtime routes protected by gateway auth (same as other POST /v1/*).
 *
 * POST /v1/runtime/sessions/clear
 * Body: { "namespace": "cursor" | "antigravity" } — clears persisted FilesystemSessionStore dir for that provider.
 */
export function registerRuntimeRoutes(app: Express): void {
  app.post(
    "/v1/runtime/sessions/clear",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const raw = (req.body ?? {}) as { namespace?: unknown };
        const namespace =
          typeof raw.namespace === "string" ? raw.namespace.trim() : "";
        if (!SAFE_NAMESPACE.test(namespace)) {
          res.status(400).json({
            error: {
              code: "invalid_namespace",
              message:
                'Body must be JSON: { "namespace": "cursor" | "antigravity" }',
            },
          });
          return;
        }

        const { sessionStore } = getGatewayServices();
        await sessionStore.clear(namespace);
        res.status(200).json({ cleared: true, namespace });
      } catch (error) {
        next(error);
      }
    },
  );
}
