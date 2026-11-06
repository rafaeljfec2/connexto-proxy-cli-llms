import type { SDKAgent } from "@cursor/sdk";
import type { NamespacedSessionStore, SessionStore } from "@agent-runtime-gateway/core";
import { createNamespacedStore } from "@agent-runtime-gateway/core";
import type {
  CreateLocalAgentParams,
  CursorClient,
  ResumeLocalAgentParams,
} from "./client.js";

export interface CursorSessionRecord {
  agentId: string;
  touchedAt: number;
}

export type SessionRecord = CursorSessionRecord;

export interface CursorSessionManagerOptions {
  maxSessions?: number;
  ttlMs?: number;
  store?:
    NamespacedSessionStore<CursorSessionRecord> | SessionStore<CursorSessionRecord>;
}

export class CursorSessionManager {
  private readonly sessions = new Map<string, CursorSessionRecord>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly store?: NamespacedSessionStore<CursorSessionRecord>;
  private removedByTtl = 0;

  constructor(
    private readonly client: CursorClient,
    options: CursorSessionManagerOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 128;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (options.store) {
      this.store =
        "namespace" in options.store
          ? options.store
          : createNamespacedStore(options.store, "cursor");
    }
  }

  async acquireAgent(
    sessionId: string,
    params: CreateLocalAgentParams,
  ): Promise<SDKAgent> {
    let existing = this.sessions.get(sessionId);
    if (existing === undefined && this.store !== undefined) {
      try {
        existing = await this.store.get(sessionId);
        if (existing !== undefined) {
          this.sessions.set(sessionId, existing);
        }
      } catch {
        // Fallback to in-memory if store read fails
      }
    }

    if (existing !== undefined) {
      existing.touchedAt = Date.now();
      if (this.store !== undefined) {
        try {
          await this.store.set(sessionId, existing);
        } catch {
          // Best effort store write
        }
      }
      try {
        return await this.client.resumeLocalAgent({
          ...params,
          agentId: existing.agentId,
        } satisfies ResumeLocalAgentParams);
      } catch {
        this.sessions.delete(sessionId);
        if (this.store !== undefined) {
          try {
            await this.store.delete(sessionId);
          } catch {
            // Best effort store delete
          }
        }
      }
    }

    const created = await this.client.createLocalAgent(params);
    const newRecord: CursorSessionRecord = {
      agentId: created.agentId,
      touchedAt: Date.now(),
    };
    this.sessions.set(sessionId, newRecord);
    if (this.store !== undefined) {
      try {
        await this.store.set(sessionId, newRecord);
      } catch {
        // Best effort store write
      }
    }
    this.evictOverflow();
    return created;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.store !== undefined) {
      void this.store.delete(sessionId).catch(() => undefined);
    }
  }

  async forgetPersisted(sessionId: string): Promise<boolean> {
    this.sessions.delete(sessionId);
    if (this.store !== undefined) {
      try {
        return await this.store.delete(sessionId);
      } catch {
        return false;
      }
    }
    return true;
  }

  getRemoteAgentId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentId;
  }

  async getSessionRecord(sessionId: string): Promise<CursorSessionRecord | undefined> {
    const fromMemory = this.sessions.get(sessionId);
    if (fromMemory !== undefined) {
      return fromMemory;
    }
    if (this.store !== undefined) {
      const fromStore = await this.store.get(sessionId);
      if (fromStore !== undefined) {
        this.sessions.set(sessionId, fromStore);
        return fromStore;
      }
    }
    return undefined;
  }

  cleanupInactive(now: number, isProtected: (sessionId: string) => boolean): number {
    let removed = 0;
    for (const [sessionId, record] of this.sessions) {
      if (isProtected(sessionId)) continue;
      if (now - record.touchedAt <= this.ttlMs) continue;
      this.sessions.delete(sessionId);
      if (this.store !== undefined) {
        void this.store.delete(sessionId).catch(() => undefined);
      }
      removed += 1;
      this.removedByTtl += 1;
    }
    return removed;
  }

  stats(): {
    storedSessions: number;
    maxSessions: number;
    ttlMs: number;
    removedByTtl: number;
  } {
    return {
      storedSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      ttlMs: this.ttlMs,
      removedByTtl: this.removedByTtl,
    };
  }

  private evictOverflow(): void {
    if (this.sessions.size <= this.maxSessions) {
      return;
    }

    const sorted = [...this.sessions.entries()].sort(
      (left, right) => left[1].touchedAt - right[1].touchedAt,
    );
    const overflow = this.sessions.size - this.maxSessions;
    for (let index = 0; index < overflow; index += 1) {
      const entry = sorted[index];
      if (entry !== undefined) {
        this.sessions.delete(entry[0]);
      }
    }
  }
}
