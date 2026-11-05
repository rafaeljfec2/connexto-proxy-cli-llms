import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import express, { type Express } from "express";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerCompletionRoutes } from "./routes/completions.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerResponseRoutes } from "./routes/responses.js";
import { loadEnv, type Env } from "./config/env.js";
import { createGatewayAuthMiddleware } from "./utils/gateway-auth.js";
import { getLogger } from "./utils/logger.js";

export function buildApp(
  config: Pick<Env, "HOST" | "GATEWAY_API_TOKEN"> = loadEnv(),
): Express {
  const app = express();

  // Server-generated correlation ID per request and response summary logging
  app.use((req, res, next) => {
    const start = performance.now();
    const requestId = crypto.randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    let logged = false;
    const logSummary = (): void => {
      if (logged) return;
      logged = true;
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const routeObject = (req as { route?: { path?: unknown } }).route;
      const routePath =
        typeof routeObject?.path === "string" ? routeObject.path : undefined;
      const route =
        routePath !== undefined
          ? `${req.baseUrl ?? ""}${routePath}`
          : (req.path ?? "").split("?")[0];

      getLogger().info(
        {
          requestId,
          method: req.method,
          route,
          status: res.statusCode,
          durationMs,
        },
        "request completed",
      );
    };

    res.on("finish", logSummary);
    res.on("close", logSummary);

    next();
  });

  // CORS preflight does not access application data and is handled before authentication.
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "authorization,content-type,x-api-key,x-gateway-api-key,idempotency-key,x-session-affinity,x-opencode-session-id,x-opencode-session,x-request-id",
    );
    res.header("Access-Control-Expose-Headers", "X-Request-ID");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(createGatewayAuthMiddleware(config));
  app.use(express.json());

  registerMetaRoutes(app);
  registerHealthRoutes(app);
  registerModelRoutes(app);
  registerChatCompletionRoutes(app);
  registerCompletionRoutes(app);
  registerResponseRoutes(app);

  return app;
}
