import type { Express, Request, Response } from "express";
import { COMPOSER_MODELS } from "@agent-runtime-gateway/compatibility-openai";
import { ANTIGRAVITY_MODELS } from "@agent-runtime-gateway/provider-antigravity";

export function registerMetaRoutes(app: Express): void {
  const handler = (_req: Request, res: Response): void => {
    res.status(200).json({
      service: "API for Cursor",
      version: "1.0.0",
      description: "Local OpenAI-compatible API for Cursor models",
      models: [
        ...COMPOSER_MODELS.map((model) => model.id),
        ...ANTIGRAVITY_MODELS.map((model) => model.id),
      ],
    });
  };

  app.get("/", handler);
  app.get("/v1", handler);
}
