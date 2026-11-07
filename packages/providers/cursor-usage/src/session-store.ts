import type { NamespacedSessionStore, SessionStore } from "@agent-runtime-gateway/core";
import { createNamespacedStore } from "@agent-runtime-gateway/core";
import type { CursorUsageSessionRecord } from "./types.js";

export interface CursorUsageSessionStoreOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly store?:
    | NamespacedSessionStore<CursorUsageSessionRecord>
    | SessionStore<CursorUsageSessionRecord>;
}

export class CursorUsageSessionStore {
  private readonly sessions = new Map<string, CursorUsageSessionRecord>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store?: NamespacedSessionStore<CursorUsageSessionRecord>;

  constructor(options: CursorUsageSessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? 64;
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.now = options.now ?? Date.now;
    if (options.store) {
      this.store =
        "namespace" in options.store
          ? options.store
          : createNamespacedStore(options.store, "cursor-usage");
    }
  }

  public get(accountId: string): CursorUsageSessionRecord | undefined {
    const record = this.sessions.get(accountId);
    if (record === undefined) {
      return undefined;
    }
    const now = this.now();
    if (now - record.touchedAt > this.ttlMs) {
      this.sessions.delete(accountId);
      if (this.store !== undefined) {
        void this.store.delete(accountId).catch(() => undefined);
      }
      return undefined;
    }
    record.touchedAt = now;
    if (this.store !== undefined) {
      void this.store.set(accountId, record).catch(() => undefined);
    }
    return record;
  }

  public async resolve(accountId: string): Promise<CursorUsageSessionRecord | undefined> {
    const inMemory = this.get(accountId);
    if (inMemory !== undefined) {
      return inMemory;
    }
    if (this.store !== undefined) {
      try {
        const persisted = await this.store.get(accountId);
        if (persisted !== undefined) {
          const now = this.now();
          if (now - persisted.touchedAt > this.ttlMs) {
            await this.store.delete(accountId);
            return undefined;
          }
          persisted.touchedAt = now;
          this.sessions.set(accountId, persisted);
          await this.store.set(accountId, persisted);
          return persisted;
        }
      } catch {
        // fall through
      }
    }
    return undefined;
  }

  public async setPersisted(record: CursorUsageSessionRecord): Promise<void> {
    const now = this.now();
    this.removeExpired(now);
    const next: CursorUsageSessionRecord = { ...record, touchedAt: now };
    this.sessions.set(record.accountId, next);
    if (this.store !== undefined) {
      await this.store.set(record.accountId, next);
    }
    this.evictOverflow();
  }

  public clearMemory(): void {
    this.sessions.clear();
  }

  public async delete(accountId: string): Promise<boolean> {
    const existedInMemory = this.sessions.delete(accountId);
    let existedInStore = false;
    if (this.store !== undefined) {
      try {
        existedInStore = await this.store.delete(accountId);
      } catch {
        // ignore
      }
    }
    return existedInMemory || existedInStore;
  }

  private removeExpired(now: number): void {
    for (const [accountId, record] of this.sessions) {
      if (now - record.touchedAt > this.ttlMs) {
        this.sessions.delete(accountId);
        if (this.store !== undefined) {
          void this.store.delete(accountId).catch(() => undefined);
        }
      }
    }
  }

  private evictOverflow(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].reduce<
        [string, CursorUsageSessionRecord] | undefined
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
