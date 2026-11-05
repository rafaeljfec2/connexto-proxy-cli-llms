import type { Request } from "express";
import { secureTokenEquals } from "./secure-token.js";

function isGatewayCredential(req: Request, candidate: string): boolean {
  const gatewayCredential = req.get("x-gateway-api-key");
  return (
    gatewayCredential !== undefined && secureTokenEquals(candidate, gatewayCredential)
  );
}

export function resolveRequestApiKey(req: Request): string | undefined {
  const authorization = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();

  if (
    token &&
    token !== "local" &&
    token !== "dummy" &&
    !isGatewayCredential(req, token)
  ) {
    return token;
  }

  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    const val = apiKeyHeader.trim();
    if (val !== "local" && val !== "dummy" && !isGatewayCredential(req, val)) {
      return val;
    }
  }

  if (process.env.CURSOR_API_KEY && process.env.CURSOR_API_KEY.trim()) {
    return process.env.CURSOR_API_KEY.trim();
  }

  return undefined;
}
