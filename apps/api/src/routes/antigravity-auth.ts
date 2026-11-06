import type { Express, Request, Response, NextFunction } from "express";
import {
  AntigravityAuthManager,
  OperationNotFoundError,
} from "@agent-runtime-gateway/provider-antigravity";
import { getGatewayServices } from "../services/gateway.js";

/** Canonical Antigravity OAuth routes (documented in OpenAPI). */
export const ANTIGRAVITY_AUTH_BASE = "/v1/providers/antigravity/auth";

/** @deprecated Use ANTIGRAVITY_AUTH_BASE — kept for backward compatibility. */
const ANTIGRAVITY_AUTH_LEGACY_BASE = "/v1/antigravity/auth";

export function registerAntigravityAuthRoutes(
  app: Express,
  customManager?: AntigravityAuthManager,
): void {
  const getManager = (): AntigravityAuthManager =>
    customManager ?? getGatewayServices().antigravityAuthManager;

  const bases = [ANTIGRAVITY_AUTH_BASE, ANTIGRAVITY_AUTH_LEGACY_BASE];

  for (const base of bases) {
    // POST .../start
    app.post(
      `${base}/start`,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const body = (req.body ?? {}) as { redirectUri?: unknown };
          let redirectUri =
            typeof body.redirectUri === "string" ? body.redirectUri : undefined;

          if (!redirectUri) {
            const rawHost = req.get("host");
            const host = rawHost && rawHost.length > 0 ? rawHost : "127.0.0.1:3000";
            redirectUri = `http://${host}${ANTIGRAVITY_AUTH_BASE}/callback`;
          }

          const result = await getManager().startAuth({ redirectUri });
          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      },
    );

    // GET .../callback
    app.get(
      `${base}/callback`,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const state =
            typeof req.query.state === "string" ? req.query.state : undefined;
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

          const accept = req.headers.accept ?? "";
          if (accept.includes("text/html")) {
            res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Autenticação Concluída</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f8fafc; color: #0f172a; }
    .card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); text-align: center; max-width: 440px; }
    .icon { font-size: 48px; margin-bottom: 16px; color: #16a34a; }
    h1 { font-size: 22px; margin-bottom: 8px; color: #0f172a; }
    p { font-size: 15px; color: #475569; line-height: 1.5; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Autenticação Concluída!</h1>
    <p>O Google Antigravity foi autenticado e suas credenciais foram gravadas com sucesso.</p>
    <p><strong>Você já pode fechar esta janela</strong> e voltar ao terminal.</p>
  </div>
</body>
</html>`);
            return;
          }

          res.status(200).json(result);
        } catch (error) {
          next(error);
        }
      },
    );

    // POST .../callback
    app.post(
      `${base}/callback`,
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

    // GET .../status
    app.get(
      `${base}/status`,
      async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
          const status = await getManager().getStatus();
          res.status(200).json(status);
        } catch (error) {
          next(error);
        }
      },
    );

    // GET .../operations/:operationId
    app.get(
      `${base}/operations/:operationId`,
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
}
