import { sha256Hex } from "../crypto.js";
import type { CursorEnv } from "../engine/types.js";
import type { CursorSdkSession } from "./types.js";
import { SDK_SESSION_TTL_MS } from "./types.js";

export const sdkSessions = new Map<string, CursorSdkSession>();

export function resetCursorSdkSessionCacheForTest(): void {
  sdkSessions.clear();
}

export async function sdkSessionIdentity(
  apiKey: string,
  sessionKey: string,
  sessionOwnerKey?: string,
): Promise<{ id: string; ownerHash: string; sessionHash: string }> {
  const ownerHash = await sha256Hex(
    sessionOwnerKey ?? `cursor-key:${await sha256Hex(apiKey)}`,
  );
  const sessionHash = await sha256Hex(sessionKey);
  return {
    id: await sha256Hex(`${ownerHash}\n${sessionHash}`),
    ownerHash,
    sessionHash,
  };
}

export function pruneSessions(now: number): void {
  for (const [key, session] of sdkSessions) {
    if (session.updatedAt + SDK_SESSION_TTL_MS < now) sdkSessions.delete(key);
  }
}

export function newLocalSdkAgentId(uuid: string): string {
  return uuid.startsWith("agent-") ? uuid : `agent-${uuid}`;
}

export function newLocalSdkRunId(uuid: string): string {
  return uuid.startsWith("run-") ? uuid : `run-${uuid}`;
}

export async function readPersistedSdkSession(
  env: CursorEnv,
  id: string,
  now: number,
): Promise<CursorSdkSession | undefined> {
  if (!env.DB) return undefined;
  try {
    const row = await env.DB.prepare(
      `SELECT agent_id, updated_at FROM sdk_sessions WHERE id = ? LIMIT 1`,
    )
      .bind(id)
      .first<{ agent_id: string; updated_at: string }>();
    if (!row?.agent_id) return undefined;
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt) || updatedAt + SDK_SESSION_TTL_MS < now) {
      await deletePersistedSdkSession(env, id);
      return undefined;
    }
    const session = { agentId: row.agent_id, updatedAt };
    sdkSessions.set(id, session);
    return session;
  } catch {
    return undefined;
  }
}

export async function savePersistedSdkSession(
  env: CursorEnv,
  identity: { id: string; ownerHash: string; sessionHash: string },
  agentId: string,
  updatedAt: Date,
): Promise<void> {
  if (!env.DB) return;
  try {
    const timestamp = updatedAt.toISOString();
    await env.DB.prepare(
      `INSERT INTO sdk_sessions (id, owner_hash, session_hash, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id = excluded.agent_id,
         updated_at = excluded.updated_at`,
    )
      .bind(
        identity.id,
        identity.ownerHash,
        identity.sessionHash,
        agentId,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    // D1 persistence is best-effort so local development without migrations still works.
  }
}

export async function deletePersistedSdkSession(
  env: CursorEnv,
  id: string,
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`DELETE FROM sdk_sessions WHERE id = ?`).bind(id).run();
  } catch {
    // Ignore missing table or transient persistence failures.
  }
}
