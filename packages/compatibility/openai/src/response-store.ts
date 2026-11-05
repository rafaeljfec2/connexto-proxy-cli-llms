export type StoredResponseStatus = "in_progress" | "completed" | "cancelled" | "failed";

export interface StoredResponse {
  id: string;
  created: number;
  model: string;
  inputItems: unknown[];
  outputItems?: unknown[];
  responseData?: Record<string, unknown>;
  toolCalls?: unknown[];
  sdkSessionKey?: string;
  /** Internal authenticated principal that owns this resource. Never exposed. */
  ownerPrincipal?: string;
  status?: StoredResponseStatus;
  /** Milliseconds since epoch when the record may be removed by TTL cleanup. */
  expiresAtMs?: number;
}

export interface ResponseStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export interface ResponseStoreStats {
  storedResponses: number;
  maxEntries: number;
  ttlMs: number;
  activePinned: number;
  removedByTtl: number;
  removedByLimit: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class ResponseSessionStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly responses = new Map<string, StoredResponse>();
  private readonly toolCallsMemory = new Map<string, unknown[]>();
  private readonly activePins = new Set<string>();
  private removedByTtl = 0;
  private removedByLimit = 0;

  constructor(options: ResponseStoreOptions | number = {}) {
    if (typeof options === "number") {
      this.maxEntries = options;
      this.ttlMs = DEFAULT_TTL_MS;
      return;
    }
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  pinActive(id: string): void {
    this.activePins.add(id);
  }

  unpinActive(id: string): void {
    this.activePins.delete(id);
  }

  isActive(id: string): boolean {
    return this.activePins.has(id);
  }

  set(id: string, response: StoredResponse): void {
    const enriched: StoredResponse = {
      ...response,
      status: response.status ?? "completed",
      expiresAtMs: Date.now() + this.ttlMs,
    };
    if (!this.responses.has(id)) {
      this.evictForCapacity(id);
    }
    this.responses.set(id, enriched);
  }

  recordTerminal(
    id: string,
    response: StoredResponse,
    status: "cancelled" | "failed",
  ): void {
    const enriched: StoredResponse = {
      ...response,
      status,
      expiresAtMs: Date.now() + this.ttlMs,
    };
    if (!this.responses.has(id)) {
      this.evictForCapacity(id);
    }
    this.responses.set(id, enriched);
  }

  get(id: string): StoredResponse | undefined {
    return this.responses.get(id);
  }

  has(id: string): boolean {
    return this.responses.has(id);
  }

  delete(id: string): boolean {
    this.toolCallsMemory.delete(id);
    this.activePins.delete(id);
    return this.responses.delete(id);
  }

  storeToolCalls(id: string, toolCalls: unknown[]): void {
    this.toolCallsMemory.set(id, toolCalls);
  }

  getToolCalls(id: string): unknown[] | undefined {
    return this.toolCallsMemory.get(id);
  }

  cleanup(now = Date.now()): { removedByTtl: number } {
    let removed = 0;
    for (const [id, record] of this.responses) {
      if (this.isActive(id)) continue;
      const expiresAt = record.expiresAtMs;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.delete(id);
        removed += 1;
        this.removedByTtl += 1;
      }
    }
    return { removedByTtl: removed };
  }

  stats(): ResponseStoreStats {
    return {
      storedResponses: this.responses.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      activePinned: this.activePins.size,
      removedByTtl: this.removedByTtl,
      removedByLimit: this.removedByLimit,
    };
  }

  clear(): void {
    this.responses.clear();
    this.toolCallsMemory.clear();
    this.activePins.clear();
    this.removedByTtl = 0;
    this.removedByLimit = 0;
  }

  private evictForCapacity(incomingId: string): void {
    if (this.responses.size < this.maxEntries) {
      return;
    }

    for (const candidateId of this.responses.keys()) {
      if (candidateId === incomingId) continue;
      if (this.isActive(candidateId)) continue;
      this.delete(candidateId);
      this.removedByLimit += 1;
      return;
    }
  }
}

export const globalResponseStore = new ResponseSessionStore({
  maxEntries: DEFAULT_MAX_ENTRIES,
  ttlMs: DEFAULT_TTL_MS,
});
