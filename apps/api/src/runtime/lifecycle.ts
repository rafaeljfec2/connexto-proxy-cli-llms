import type { ResponseSessionStore } from "@agent-runtime-gateway/compatibility-openai";
import type { ActiveResourceTracker } from "@agent-runtime-gateway/core";
import type { CursorSessionManager } from "@agent-runtime-gateway/provider-cursor";

export interface RuntimeLifecycleSnapshot {
  responses: ReturnType<ResponseSessionStore["stats"]>;
  sessions: ReturnType<CursorSessionManager["stats"]>;
  executions: ReturnType<ActiveResourceTracker["counts"]>;
  memory: NodeJS.MemoryUsage;
}

export interface RuntimeLifecycleOptions {
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export interface RuntimeLifecycleDeps {
  responseStore: ResponseSessionStore;
  sessions: CursorSessionManager;
  tracker: ActiveResourceTracker;
  options: RuntimeLifecycleOptions;
}

export class RuntimeLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private cleanupInProgress = false;

  constructor(private readonly deps: RuntimeLifecycleDeps) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    const intervalMs = this.deps.options.intervalMs;
    this.timer = setInterval(() => {
      this.runCleanup();
    }, intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  runCleanup(): void {
    if (this.cleanupInProgress) {
      return;
    }
    this.cleanupInProgress = true;
    try {
      this.deps.responseStore.cleanup(Date.now());
      this.deps.sessions.cleanupInactive(Date.now(), (sessionId) =>
        this.deps.tracker.isSessionActive(sessionId),
      );
    } catch (error) {
      this.deps.options.onError?.(error);
    } finally {
      this.cleanupInProgress = false;
    }
  }

  snapshot(): RuntimeLifecycleSnapshot {
    return {
      responses: this.deps.responseStore.stats(),
      sessions: this.deps.sessions.stats(),
      executions: this.deps.tracker.counts(),
      memory: process.memoryUsage(),
    };
  }
}
