import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";

export function buildApp() {
  const app = Fastify({
    logger: { level: "error" },
  });

  registerHealthRoutes(app);

  return app;
}
