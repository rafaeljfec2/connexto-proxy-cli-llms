export interface StoredResponse {
  id: string;
  created: number;
  model: string;
  inputItems: unknown[];
  outputItems?: unknown[];
  responseData?: Record<string, unknown>;
  toolCalls?: unknown[];
  sdkSessionKey?: string;
}

export class ResponseSessionStore {
  private readonly maxEntries: number;
  private readonly responses = new Map<string, StoredResponse>();
  private readonly toolCallsMemory = new Map<string, unknown[]>();

  constructor(maxEntries = 512) {
    this.maxEntries = maxEntries;
  }

  set(id: string, response: StoredResponse): void {
    if (this.responses.size >= this.maxEntries && !this.responses.has(id)) {
      const oldestKey = this.responses.keys().next().value;
      if (oldestKey !== undefined) {
        this.responses.delete(oldestKey);
        this.toolCallsMemory.delete(oldestKey);
      }
    }
    this.responses.set(id, response);
  }

  get(id: string): StoredResponse | undefined {
    return this.responses.get(id);
  }

  has(id: string): boolean {
    return this.responses.has(id);
  }

  delete(id: string): boolean {
    this.toolCallsMemory.delete(id);
    return this.responses.delete(id);
  }

  storeToolCalls(id: string, toolCalls: unknown[]): void {
    this.toolCallsMemory.set(id, toolCalls);
  }

  getToolCalls(id: string): unknown[] | undefined {
    return this.toolCallsMemory.get(id);
  }

  stats(): { storedResponses: number; maxEntries: number } {
    return {
      storedResponses: this.responses.size,
      maxEntries: this.maxEntries,
    };
  }

  clear(): void {
    this.responses.clear();
    this.toolCallsMemory.clear();
  }
}

export const globalResponseStore = new ResponseSessionStore(512);
