import type { RequestHandler } from "express";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";
import type { Env } from "../config/env.js";
import { isLoopbackHost } from "./network.js";
import { secureTokenEquals } from "./secure-token.js";

const publicReadEndpoints = new Set([
  "GET /",
  "GET /v1",
  "GET /health",
  "GET /v1/models",
]);

export function createGatewayAuthMiddleware(
  config: Pick<Env, "HOST" | "GATEWAY_API_TOKEN">,
): RequestHandler {
  return (req, res, next) => {
    const method = req.method === "HEAD" ? "GET" : req.method;
    const path = normalizePath(req.path);
    const isPublicRead =
      publicReadEndpoints.has(`${method} ${path}`) ||
      (method === "GET" && /^\/v1\/models\/[^/]+$/.test(path));

    if (req.method === "OPTIONS" || isPublicRead) return next();

    if (!config.GATEWAY_API_TOKEN && isLoopbackHost(config.HOST)) {
      return next();
    }

    const suppliedToken = req.get("x-gateway-api-key");
    if (
      suppliedToken !== undefined &&
      config.GATEWAY_API_TOKEN !== undefined &&
      secureTokenEquals(suppliedToken, config.GATEWAY_API_TOKEN)
    ) {
      return next();
    }

    res
      .status(401)
      .json(openAiErrorPayload("Missing or invalid gateway API key", "unauthorized"));
  };
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
