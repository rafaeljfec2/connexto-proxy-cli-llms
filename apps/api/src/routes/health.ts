import type { Express, Request, Response } from "express";

export function registerHealthRoutes(app: Express): void {
  app.get("/health", (_req: Request, res: Response): void => {
    res.status(200).json({
      status: "ok",
      service: "agent-runtime-gateway",
    });
  });
}
