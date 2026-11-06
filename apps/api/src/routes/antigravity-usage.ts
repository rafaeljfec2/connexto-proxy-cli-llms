import type { Express, Request, Response, NextFunction } from "express";
import type { AntigravityUsageService } from "@agent-runtime-gateway/provider-antigravity";
import { getGatewayServices } from "../services/gateway.js";

export const ANTIGRAVITY_USAGE_ROUTE = "/v1/providers/antigravity/usage";

export function registerAntigravityUsageRoutes(
  app: Express,
  customService?: AntigravityUsageService,
): void {
  const getUsageService = (): AntigravityUsageService =>
    customService ?? getGatewayServices().antigravityUsageService;

  app.get(
    ANTIGRAVITY_USAGE_ROUTE,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const usageService = getUsageService();
        const snapshot = await usageService.getUsage();

        let statusCode = 200;

        if (snapshot.status === "available" || snapshot.status === "unsupported") {
          statusCode = 200;
        } else if (snapshot.status === "unauthenticated") {
          statusCode = 503;
        } else if (snapshot.status === "error") {
          if (snapshot.error?.code === "upstream_error") {
            statusCode = 502;
          } else {
            statusCode = 503;
          }
        }

        res.status(statusCode).json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );
}
