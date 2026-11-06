interface AcpSessionRecord {
  readonly acpSessionId: string;
  touchedAt: number;
}

export interface AntigravitySessionStoreOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class AntigravitySessionStore {
  private readonly sessions = new Map<string, AcpSessionRecord>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: AntigravitySessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? 128;
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
  }

  public get(gatewaySessionId: string): string | undefined {
    const record = this.sessions.get(gatewaySessionId);
    if (record === undefined) {
      return undefined;
    }
    const now = this.now();
    if (now - record.touchedAt > this.ttlMs) {
      this.sessions.delete(gatewaySessionId);
      return undefined;
    }
    record.touchedAt = now;
    return record.acpSessionId;
  }

  public set(gatewaySessionId: string, acpSessionId: string): void {
    const now = this.now();
    this.removeExpired(now);
    this.sessions.set(gatewaySessionId, { acpSessionId, touchedAt: now });
    this.evictOverflow();
  }

  private removeExpired(now: number): void {
    for (const [gatewaySessionId, record] of this.sessions) {
      if (now - record.touchedAt > this.ttlMs) {
        this.sessions.delete(gatewaySessionId);
      }
    }
  }

  private evictOverflow(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].reduce<
        [string, AcpSessionRecord] | undefined
      >((candidate, entry) => {
        if (candidate === undefined || entry[1].touchedAt < candidate[1].touchedAt) {
          return entry;
        }
        return candidate;
      }, undefined);
      if (oldest === undefined) {
        return;
      }
      this.sessions.delete(oldest[0]);
    }
  }
}
