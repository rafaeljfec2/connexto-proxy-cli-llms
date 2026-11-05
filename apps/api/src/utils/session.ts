import type { Request } from "express";

export function resolveSessionAffinity(
  req: Request,
  fallbackId: string,
  previousSessionKey?: string,
): string {
  return (
    (req.headers["x-session-affinity"] as string | undefined) ??
    (req.headers["x-opencode-session"] as string | undefined) ??
    previousSessionKey ??
    fallbackId
  );
}
