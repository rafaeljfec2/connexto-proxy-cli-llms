import type { NamespacedSessionStore, SessionStore } from "@agent-runtime-gateway/core";
import { createNamespacedStore } from "@agent-runtime-gateway/core";

export interface AcpSessionRecord {
  readonly acpSessionId: string;
  touchedAt: number;
}

export interface AntigravitySessionStoreOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly store?:
    NamespacedSessionStore<AcpSessionRecord> | SessionStore<AcpSessionRecord>;
}

export class AntigravitySessionStore {
  private readonly sessions = new Map<string, AcpSessionRecord>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store?: NamespacedSessionStore<AcpSessionRecord>;

  constructor(options: AntigravitySessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? 128;
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
    if (options.store) {
      this.store =
        "namespace" in options.store
          ? options.store
          : createNamespacedStore(options.store, "antigravity");
    }
  }

  public get(gatewaySessionId: string): string | undefined {
    const record = this.sessions.get(gatewaySessionId);
    if (record === undefined) {
      return undefined;
    }
    const now = this.now();
    if (now - record.touchedAt > this.ttlMs) {
      this.sessions.delete(gatewaySessionId);
      if (this.store !== undefined) {
        void this.store.delete(gatewaySessionId).catch(() => undefined);
      }
      return undefined;
    }
    record.touchedAt = now;
    if (this.store !== undefined) {
      void this.store.set(gatewaySessionId, record).catch(() => undefined);
    }
    return record.acpSessionId;
  }

  public async resolve(gatewaySessionId: string): Promise<string | undefined> {
    const inMemory = this.get(gatewaySessionId);
    if (inMemory !== undefined) {
      return inMemory;
    }

    if (this.store !== undefined) {
      try {
        const persisted = await this.store.get(gatewaySessionId);
        if (persisted !== undefined) {
          const now = this.now();
          if (now - persisted.touchedAt > this.ttlMs) {
            await this.store.delete(gatewaySessionId);
            return undefined;
          }
          persisted.touchedAt = now;
          this.sessions.set(gatewaySessionId, persisted);
          await this.store.set(gatewaySessionId, persisted);
          return persisted.acpSessionId;
        }
      } catch {
        // Fallback to in-memory if store retrieval fails
      }
    }

    return undefined;
  }

  public set(gatewaySessionId: string, acpSessionId: string): void {
    const now = this.now();
    this.removeExpired(now);
    const record: AcpSessionRecord = { acpSessionId, touchedAt: now };
    this.sessions.set(gatewaySessionId, record);
    if (this.store !== undefined) {
      void this.store.set(gatewaySessionId, record).catch(() => undefined);
    }
    this.evictOverflow();
  }

  public async setPersisted(
    gatewaySessionId: string,
    acpSessionId: string,
  ): Promise<void> {
    const now = this.now();
    this.removeExpired(now);
    const record: AcpSessionRecord = { acpSessionId, touchedAt: now };
    this.sessions.set(gatewaySessionId, record);
    if (this.store !== undefined) {
      await this.store.set(gatewaySessionId, record);
    }
    this.evictOverflow();
  }

  public async delete(gatewaySessionId: string): Promise<boolean> {
    const existedInMemory = this.sessions.delete(gatewaySessionId);
    let existedInStore = false;
    if (this.store !== undefined) {
      try {
        existedInStore = await this.store.delete(gatewaySessionId);
      } catch {
        // Ignore store deletion failure
      }
    }
    return existedInMemory || existedInStore;
  }

  private removeExpired(now: number): void {
    for (const [gatewaySessionId, record] of this.sessions) {
      if (now - record.touchedAt > this.ttlMs) {
        this.sessions.delete(gatewaySessionId);
        if (this.store !== undefined) {
          void this.store.delete(gatewaySessionId).catch(() => undefined);
        }
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
