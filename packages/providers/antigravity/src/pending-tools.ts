export interface PendingToolCallRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly sessionId: string;
  readonly createdAt: number;
  consumed: boolean;
}

export class PendingToolRegistryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "pending_call_not_found"
      | "session_mismatch"
      | "call_already_consumed"
      | "tool_name_mismatch",
  ) {
    super(message);
    this.name = "PendingToolRegistryError";
  }
}

export interface PendingToolRegistryOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class PendingToolRegistry {
  private readonly calls = new Map<string, PendingToolCallRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PendingToolRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  public register(call: {
    readonly callId: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly sessionId: string;
  }): void {
    this.cleanup();
    this.calls.set(call.callId, {
      ...call,
      createdAt: this.now(),
      consumed: false,
    });
  }

  public get(callId: string): PendingToolCallRecord | undefined {
    this.cleanup();
    return this.calls.get(callId);
  }

  public validateAndConsume(
    callId: string,
    sessionId: string,
    toolName?: string,
  ): PendingToolCallRecord {
    this.cleanup();
    const call = this.calls.get(callId);
    if (!call) {
      throw new PendingToolRegistryError(
        `No pending tool call found for id '${callId}'.`,
        "pending_call_not_found",
      );
    }
    if (call.sessionId !== sessionId) {
      throw new PendingToolRegistryError(
        `Tool call '${callId}' belongs to session '${call.sessionId}', not '${sessionId}'.`,
        "session_mismatch",
      );
    }
    if (call.consumed) {
      throw new PendingToolRegistryError(
        `Tool call '${callId}' has already been consumed. Duplicate submission is rejected.`,
        "call_already_consumed",
      );
    }
    if (toolName && call.toolName !== toolName) {
      throw new PendingToolRegistryError(
        `Tool call '${callId}' was registered for tool '${call.toolName}', but received result for '${toolName}'.`,
        "tool_name_mismatch",
      );
    }
    call.consumed = true;
    return call;
  }

  public listPending(sessionId?: string): readonly PendingToolCallRecord[] {
    this.cleanup();
    const result: PendingToolCallRecord[] = [];
    for (const record of this.calls.values()) {
      if (!record.consumed && (sessionId === undefined || record.sessionId === sessionId)) {
        result.push(record);
      }
    }
    return result;
  }

  public cleanup(): void {
    const current = this.now();
    for (const [id, record] of this.calls.entries()) {
      if (current - record.createdAt > this.ttlMs) {
        this.calls.delete(id);
      }
    }
  }

  public clear(): void {
    this.calls.clear();
  }
}

