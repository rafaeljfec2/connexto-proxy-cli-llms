import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import express, { type Express } from "express";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerCompletionRoutes } from "./routes/completions.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerResponseRoutes } from "./routes/responses.js";
import { registerSwaggerRoutes } from "./routes/swagger.js";
import { loadEnv, type Env } from "./config/env.js";
import { createGatewayAuthMiddleware } from "./utils/gateway-auth.js";
import { createCorsMiddleware } from "./utils/cors.js";
import { getLogger } from "./utils/logger.js";
import { createErrorHandler } from "./utils/error-handler.js";
import { createHttpPayloadLoggingMiddleware } from "./middleware/http-payload-logging.js";

export function buildApp(
  config: Pick<Env, "HOST"> &
    Partial<
      Pick<
        Env,
        | "GATEWAY_API_TOKEN"
        | "GATEWAY_API_TOKENS"
        | "CORS_ORIGINS"
        | "LOG_HTTP_PAYLOADS"
        | "LOG_HTTP_PAYLOAD_MAX_BYTES"
        | "GATEWAY_JSON_BODY_LIMIT_BYTES"
      >
    > = loadEnv(),
): Express {
  const jsonBodyLimitBytes =
    config.GATEWAY_JSON_BODY_LIMIT_BYTES ?? 32 * 1024 * 1024;
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

  app.use(
    createCorsMiddleware({
      host: config.HOST,
      origins: config.CORS_ORIGINS,
    }),
  );

  registerSwaggerRoutes(app);

  app.use(createGatewayAuthMiddleware(config));
  app.use(express.json({ limit: jsonBodyLimitBytes }));
  app.use(createHttpPayloadLoggingMiddleware(config));

  registerMetaRoutes(app);
  registerHealthRoutes(app);
  registerModelRoutes(app);
  registerChatCompletionRoutes(app);
  registerCompletionRoutes(app);
  registerResponseRoutes(app);
  app.use(createErrorHandler());

  return app;
}
