import { createHash } from "node:crypto";
import type { Request } from "express";

/**
 * Resolves the effective provider session key for a request.
 *
 * Client-supplied affinity headers are never forwarded raw: they are scoped to
 * the authenticated principal so two consumers cannot collide on the same
 * session key by submitting identical header values. Previously chained keys
 * come from an owned stored Response and are already principal-scoped.
 * Priority is preserved: affinity header, then previous session key, then the
 * server-generated fallback ID.
 */
export function resolveSessionAffinity(
  req: Request,
  fallbackId: string,
  principal: string,
  previousSessionKey?: string,
): string {
  const affinityHeader =
    req.headers["x-session-affinity"] ?? req.headers["x-opencode-session"];
  const affinity = Array.isArray(affinityHeader) ? affinityHeader[0] : affinityHeader;

  if (typeof affinity === "string" && affinity.length > 0) {
    return scopedSessionKey(principal, affinity);
  }

  return previousSessionKey ?? fallbackId;
}

/**
 * Derives a provider session key that binds an affinity value to the
 * principal it belongs to.
 */
export function scopedSessionKey(principal: string, affinity: string): string {
  return `ssk_${createHash("sha256")
    .update(`${principal}\n${affinity}`, "utf8")
    .digest("hex")}`;
}
