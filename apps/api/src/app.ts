import express, { type Express } from "express";
import { registerHealthRoutes } from "./routes/health.js";

export function buildApp(): Express {
  const app = express();

  app.use(express.json());
  registerHealthRoutes(app);

  return app;
}
