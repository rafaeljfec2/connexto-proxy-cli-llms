import type { Request, RequestHandler, Response } from "express";
import { isLoopbackHost } from "./network.js";

const allowedMethods = ["GET", "POST", "DELETE", "OPTIONS"] as const;
const allowedMethodSet = new Set<string>(allowedMethods);
const allowedHeaders = [
  "authorization",
  "content-type",
  "x-api-key",
  "x-gateway-api-key",
  "idempotency-key",
  "x-session-affinity",
  "x-opencode-session-id",
  "x-opencode-session",
  "x-request-id",
] as const;
const allowedHeaderSet = new Set<string>(allowedHeaders);

export interface CorsPolicy {
  readonly host: string;
  readonly origins: readonly string[] | undefined;
}

interface AllowedPreflight {
  readonly method: string;
  readonly headers: readonly string[];
}

export function createCorsMiddleware(policy: CorsPolicy): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("Origin");
    res.vary("Origin");

    if (req.method === "OPTIONS") {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
    }

    if (origin === undefined) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    const isAllowedOrigin = originIsAllowed(origin, policy);

    if (req.method === "OPTIONS") {
      const preflight = getAllowedPreflight(req);
      if (!isAllowedOrigin || preflight === undefined) {
        res.status(403).end();
        return;
      }

      setAllowedOriginHeader(res, origin);
      res.setHeader("Access-Control-Allow-Methods", preflight.method);
      if (preflight.headers.length > 0) {
        res.setHeader("Access-Control-Allow-Headers", preflight.headers.join(","));
      }
      res.status(204).end();
      return;
    }

    if (isAllowedOrigin) {
      setAllowedOriginHeader(res, origin);
      res.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
    }
    next();
  };
}

function originIsAllowed(origin: string, policy: CorsPolicy): boolean {
  if (!isValidOriginHeader(origin)) return false;

  if (policy.origins !== undefined) return policy.origins.includes(origin);
  if (!isLoopbackHost(policy.host)) return false;

  try {
    const parsedOrigin = new URL(origin);
    return isLoopbackHost(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

function isValidOriginHeader(origin: string): boolean {
  try {
    const parsedOrigin = new URL(origin);
    return (
      (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
      parsedOrigin.origin === origin &&
      parsedOrigin.username.length === 0 &&
      parsedOrigin.password.length === 0 &&
      parsedOrigin.pathname === "/" &&
      parsedOrigin.search.length === 0 &&
      parsedOrigin.hash.length === 0
    );
  } catch {
    return false;
  }
}

function getAllowedPreflight(req: Request): AllowedPreflight | undefined {
  const requestedMethod = req.get("Access-Control-Request-Method");
  if (requestedMethod === undefined || !allowedMethodSet.has(requestedMethod)) {
    return undefined;
  }

  const requestedHeaders = req.get("Access-Control-Request-Headers");
  if (requestedHeaders === undefined || requestedHeaders.trim() === "") {
    return { method: requestedMethod, headers: [] };
  }

  const headerNames = requestedHeaders
    .split(",")
    .map((header) => header.trim().toLowerCase());
  if (
    !headerNames.every((header) => header.length > 0 && allowedHeaderSet.has(header))
  ) {
    return undefined;
  }

  return { method: requestedMethod, headers: headerNames };
}

function setAllowedOriginHeader(res: Response, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
}
