import type { Express, Request, Response, NextFunction } from "express";
import type { AntigravityRuntimeSessionClearReport } from "@agent-runtime-gateway/provider-antigravity";
import { getGatewayServices } from "../services/gateway.js";

const SAFE_NAMESPACE = /^[a-zA-Z0-9_-]+$/;

type RuntimeSessionsClearBody = {
  cleared: boolean;
  namespace: string;
  mapped_acp_ids_count?: number;
  listed_acp_sessions_count?: number;
  acp_sessions_closed?: number;
  acp_close_failures?: number;
  credentials_purged?: boolean;
  warnings?: string[];
};

/**
 * Mutating runtime routes protected by gateway auth (same as other POST /v1/*).
 *
 * POST /v1/runtime/sessions/clear
 * Body: { "namespace": "cursor" | "antigravity" | "cursor-usage" } — clears persisted FilesystemSessionStore dir for that provider.
 */
export function registerRuntimeRoutes(app: Express): void {
  app.post(
    "/v1/runtime/sessions/clear",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const raw = (req.body ?? {}) as { namespace?: unknown };
        const namespace = typeof raw.namespace === "string" ? raw.namespace.trim() : "";
        if (!SAFE_NAMESPACE.test(namespace)) {
          res.status(400).json({
            error: {
              code: "invalid_namespace",
              message: 'Body must be JSON: { "namespace": "cursor" | "antigravity" | "cursor-usage" }',
            },
          });
          return;
        }

        const {
          sessionStore,
          cursorProvider,
          antigravityProvider,
          antigravityAuthManager,
          cursorUsageService,
        } = getGatewayServices();
        let agReport: AntigravityRuntimeSessionClearReport | undefined;
        if (namespace === "antigravity") {
          agReport = await antigravityProvider.closePersistedAcpSessions();
          await antigravityAuthManager.clearCredentials();
        }
        if (namespace === "cursor-usage") {
          await cursorUsageService.clearPersistedSessions();
        }
        await sessionStore.clear(namespace);
        if (namespace === "cursor") {
          cursorProvider.clearSessionCaches();
        }
        if (namespace === "antigravity") {
          antigravityProvider.clearSessionCaches();
        }
        const body: RuntimeSessionsClearBody =
          agReport === undefined
            ? { cleared: true, namespace }
            : {
                cleared: true,
                namespace,
                mapped_acp_ids_count: agReport.mapped_acp_ids_count,
                listed_acp_sessions_count: agReport.listed_acp_sessions_count,
                acp_sessions_closed: agReport.acp_sessions_closed,
                acp_close_failures: agReport.acp_close_failures,
                credentials_purged: true,
                warnings: [...agReport.warnings],
              };
        res.status(200).json(body);
      } catch (error) {
        next(error);
      }
    },
  );
}
