import type { Express, Request, Response } from "express";
import { COMPOSER_MODELS } from "@agent-runtime-gateway/compatibility-openai";

export function registerMetaRoutes(app: Express): void {
  const handler = (_req: Request, res: Response): void => {
    res.status(200).json({
      service: "API for Cursor",
      version: "1.0.0",
      description: "Local OpenAI-compatible API for Cursor models",
      models: COMPOSER_MODELS.map((m) => m.id),
    });
  };

  app.get("/", handler);
  app.get("/v1", handler);
}
