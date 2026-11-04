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

export class CursorSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxSessions: number;

  constructor(
    private readonly client: CursorClient,
    options: { maxSessions?: number } = {},
  ) {
    this.maxSessions = options.maxSessions ?? 128;
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
