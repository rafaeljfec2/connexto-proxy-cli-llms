import type { SDKAgent } from "@cursor/sdk";
import type {
  CreateLocalAgentParams,
  CursorClient,
  ResumeLocalAgentParams,
} from "./client.js";

interface SessionRecord {
  agentId: string;
  touchedAt: number;
}

export interface CursorSessionManagerOptions {
  maxSessions?: number;
  ttlMs?: number;
}

export class CursorSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private removedByTtl = 0;

  constructor(
    private readonly client: CursorClient,
    options: CursorSessionManagerOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 128;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  async acquireAgent(
    sessionId: string,
    params: CreateLocalAgentParams,
  ): Promise<SDKAgent> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      existing.touchedAt = Date.now();
      try {
        return await this.client.resumeLocalAgent({
          ...params,
          agentId: existing.agentId,
        } satisfies ResumeLocalAgentParams);
      } catch {
        this.sessions.delete(sessionId);
      }
    }

    const created = await this.client.createLocalAgent(params);
    this.sessions.set(sessionId, {
      agentId: created.agentId,
      touchedAt: Date.now(),
    });
    this.evictOverflow();
    return created;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getRemoteAgentId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentId;
  }

  cleanupInactive(now: number, isProtected: (sessionId: string) => boolean): number {
    let removed = 0;
    for (const [sessionId, record] of this.sessions) {
      if (isProtected(sessionId)) continue;
      if (now - record.touchedAt <= this.ttlMs) continue;
      this.sessions.delete(sessionId);
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
