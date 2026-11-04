import express, { type Express } from "express";
import { registerChatCompletionRoutes } from "./routes/chat-completions.js";
import { registerCompletionRoutes } from "./routes/completions.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerResponseRoutes } from "./routes/responses.js";

export function buildApp(): Express {
  const app = express();

  app.use(express.json());

  // CORS headers matching Composer API
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "authorization,content-type,x-api-key,idempotency-key,x-session-affinity,x-opencode-session-id,x-opencode-session",
    );
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  registerMetaRoutes(app);
  registerHealthRoutes(app);
  registerModelRoutes(app);
  registerChatCompletionRoutes(app);
  registerCompletionRoutes(app);
  registerResponseRoutes(app);

  return app;
}
