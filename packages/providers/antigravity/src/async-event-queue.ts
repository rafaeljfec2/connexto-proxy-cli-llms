import type { AgentEvent } from "@agent-runtime-gateway/core";

export class AsyncEventQueue implements AsyncIterableIterator<AgentEvent, void> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent, void>) => void> =
    [];
  private closed = false;

  public [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent, void> {
    return this;
  }

  public next(): Promise<IteratorResult<AgentEvent, void>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  public return(): Promise<IteratorResult<AgentEvent, void>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  public push(event: AgentEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    this.values.push(event);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}
