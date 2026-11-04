import type { Request } from "express";

export function resolveRequestApiKey(req: Request): string | undefined {
  const authorization = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();

  if (token && token !== "local" && token !== "dummy") {
    return token;
  }

  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    const val = apiKeyHeader.trim();
    if (val !== "local" && val !== "dummy") {
      return val;
    }
  }

  if (process.env.CURSOR_API_KEY && process.env.CURSOR_API_KEY.trim()) {
    return process.env.CURSOR_API_KEY.trim();
  }

  return undefined;
}
