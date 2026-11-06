import type { RequestHandler } from "express";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";
import type { Env } from "../config/env.js";
import { isLoopbackHost } from "./network.js";
import { secureTokenEquals } from "./secure-token.js";
import { LOCAL_PRINCIPAL, principalFromCredential } from "./identity.js";
import type { Response } from "express";

const publicReadEndpoints = new Set([
  "GET /",
  "GET /v1",
  "GET /health",
  "GET /v1/models",
  "GET /v1/providers/antigravity/auth/callback",
  "GET /v1/antigravity/auth/callback",
]);

type GatewayAuthConfig = Pick<Env, "HOST"> &
  Partial<Pick<Env, "GATEWAY_API_TOKEN" | "GATEWAY_API_TOKENS">>;

function collectGatewayCredentials(config: GatewayAuthConfig): string[] {
  // loadEnv guarantees the primary token never duplicates an entry from the
  // secondary list; direct buildApp callers pass internally-defined configs.
  const credentials = [config.GATEWAY_API_TOKEN, ...(config.GATEWAY_API_TOKENS ?? [])];
  return credentials.filter(
    (credential): credential is string => credential !== undefined,
  );
}

function stampPrincipal(res: Response, principal: string): void {
  res.locals.principal = principal;
}

export function createGatewayAuthMiddleware(config: GatewayAuthConfig): RequestHandler {
  const credentials = collectGatewayCredentials(config);
  return (req, res, next) => {
    const method = req.method === "HEAD" ? "GET" : req.method;
    const path = normalizePath(req.path);
    const isPublicRead =
      publicReadEndpoints.has(`${method} ${path}`) ||
      (method === "GET" && /^\/v1\/models\/[^/]+$/.test(path));

    if (req.method === "OPTIONS" || isPublicRead) return next();

    if (credentials.length === 0 && isLoopbackHost(config.HOST)) {
      stampPrincipal(res, LOCAL_PRINCIPAL);
      return next();
    }

    const suppliedToken = req.get("x-gateway-api-key");
    if (suppliedToken !== undefined) {
      for (const credential of credentials) {
        if (secureTokenEquals(suppliedToken, credential)) {
          stampPrincipal(res, principalFromCredential(credential));
          return next();
        }
      }
    }

    res
      .status(401)
      .json(openAiErrorPayload("Missing or invalid gateway API key", "unauthorized"));
  };
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
