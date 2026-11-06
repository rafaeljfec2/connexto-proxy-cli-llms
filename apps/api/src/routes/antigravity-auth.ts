import type { Express, Request, Response, NextFunction } from "express";
import {
  AntigravityAuthManager,
  OperationNotFoundError,
} from "@agent-runtime-gateway/provider-antigravity";
import { getGatewayServices } from "../services/gateway.js";

export function registerAntigravityAuthRoutes(
  app: Express,
  customManager?: AntigravityAuthManager,
): void {
  const getManager = (): AntigravityAuthManager =>
    customManager ?? getGatewayServices().antigravityAuthManager;

  // POST /v1/antigravity/auth/start
  app.post(
    "/v1/antigravity/auth/start",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as { redirectUri?: unknown };
        const redirectUri =
          typeof body.redirectUri === "string" ? body.redirectUri : undefined;

        const result = await getManager().startAuth({ redirectUri });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /v1/antigravity/auth/callback
  app.get(
    "/v1/antigravity/auth/callback",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const state = typeof req.query.state === "string" ? req.query.state : undefined;
        const code = typeof req.query.code === "string" ? req.query.code : undefined;
        const error = typeof req.query.error === "string" ? req.query.error : undefined;
        const errorDescription =
          typeof req.query.error_description === "string"
            ? req.query.error_description
            : undefined;

        const result = await getManager().handleCallback({
          state,
          code,
          error,
          error_description: errorDescription,
        });

        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /v1/antigravity/auth/callback
  app.post(
    "/v1/antigravity/auth/callback",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as {
          state?: unknown;
          code?: unknown;
          error?: unknown;
          error_description?: unknown;
        };

        const state = typeof body.state === "string" ? body.state : undefined;
        const code = typeof body.code === "string" ? body.code : undefined;
        const error = typeof body.error === "string" ? body.error : undefined;
        const errorDescription =
          typeof body.error_description === "string"
            ? body.error_description
            : undefined;

        const result = await getManager().handleCallback({
          state,
          code,
          error,
          error_description: errorDescription,
        });

        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /v1/antigravity/auth/status
  app.get(
    "/v1/antigravity/auth/status",
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const status = await getManager().getStatus();
        res.status(200).json(status);
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /v1/antigravity/auth/operations/:operationId
  app.get(
    "/v1/antigravity/auth/operations/:operationId",
    (req: Request, res: Response, next: NextFunction): void => {
      try {
        const rawParam = req.params.operationId;
        const operationId = Array.isArray(rawParam)
          ? (rawParam[0] ?? "")
          : (rawParam ?? "");
        const operation = getManager().getOperation(operationId);
        if (!operation) {
          throw new OperationNotFoundError(operationId);
        }
        res.status(200).json(operation);
      } catch (error) {
        next(error);
      }
    },
  );
}
