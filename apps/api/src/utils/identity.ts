import { createHash } from "node:crypto";
import type {
  ResponseSessionStore,
  StoredResponse,
} from "@agent-runtime-gateway/compatibility-openai";

export const LOCAL_PRINCIPAL = "local";

/**
 * Derives an internal principal identifier from an authenticated gateway
 * credential. The credential itself is never stored, logged, or exposed:
 * only this one-way digest is retained as resource ownership.
 */
export function principalFromCredential(credential: string): string {
  return `gw_${createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

/**
 * Reads the authenticated principal stamped by the gateway auth middleware.
 * Absence means the request never passed through an authenticated context.
 */
export function resolveRequestPrincipal(
  locals: Record<string, unknown>,
): string | undefined {
  const principal = locals.principal;
  return typeof principal === "string" && principal.length > 0 ? principal : undefined;
}

/**
 * Returns a stored Response only when it belongs to the authenticated
 * principal. Unknown, foreign, and owner-less resources are indistinguishable:
 * callers reject all three with the same not-found payload.
 */
export function findOwnedResponse(
  store: ResponseSessionStore,
  id: string,
  principal: string,
): StoredResponse | undefined {
  const stored = store.get(id);
  if (stored?.ownerPrincipal === undefined) {
    return undefined;
  }
  return stored.ownerPrincipal === principal ? stored : undefined;
}
