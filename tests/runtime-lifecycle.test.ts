import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { ActiveResourceTracker } from "@agent-runtime-gateway/core";
import { ResponseSessionStore } from "@agent-runtime-gateway/compatibility-openai";
import { CursorSessionManager } from "@agent-runtime-gateway/provider-cursor";
import { RuntimeLifecycle } from "../apps/api/src/runtime/lifecycle.js";

function createSessionManager(): CursorSessionManager {
  return new CursorSessionManager(
    {
      listModels: vi.fn(),
      createLocalAgent: vi.fn(),
      resumeLocalAgent: vi.fn(),
    },
    { ttlMs: 1_000 },
  );
}

describe("RuntimeLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs periodic cleanup", () => {
    vi.setSystemTime(0);
    const responseStore = new ResponseSessionStore({ maxEntries: 10, ttlMs: 1_000 });
    responseStore.set("resp_1", {
      id: "resp_1",
      created: 0,
      model: "composer-2.5",
      inputItems: [],
      ownerPrincipal: "p",
    });
    const sessions = createSessionManager();
    const tracker = new ActiveResourceTracker();
    const lifecycle = new RuntimeLifecycle({
      responseStore,
      sessions,
      tracker,
      options: { intervalMs: 500 },
    });

    lifecycle.start();
    vi.advanceTimersByTime(1_500);
    lifecycle.stop();
    expect(responseStore.has("resp_1")).toBe(false);
  });

  it("does not create duplicate timers", () => {
    const lifecycle = new RuntimeLifecycle({
      responseStore: new ResponseSessionStore(),
      sessions: createSessionManager(),
      tracker: new ActiveResourceTracker(),
      options: { intervalMs: 500 },
    });
    lifecycle.start();
    const first = lifecycle.isRunning();
    lifecycle.start();
    expect(lifecycle.isRunning()).toBe(first);
    lifecycle.stop();
    expect(lifecycle.isRunning()).toBe(false);
  });

  it("swallows cleanup errors without throwing", () => {
    const responseStore = new ResponseSessionStore();
    const lifecycle = new RuntimeLifecycle({
      responseStore,
      sessions: createSessionManager(),
      tracker: new ActiveResourceTracker(),
      options: {
        intervalMs: 500,
        onError: () => undefined,
      },
    });
    vi.spyOn(responseStore, "cleanup").mockImplementation(() => {
      throw new Error("cleanup failed");
    });
    expect(() => lifecycle.runCleanup()).not.toThrow();
  });

  it("does not run cleanup concurrently", () => {
    const responseStore = new ResponseSessionStore();
    let concurrent = 0;
    let maxConcurrent = 0;
    vi.spyOn(responseStore, "cleanup").mockImplementation(function cleanupMock() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      lifecycle.runCleanup();
      concurrent -= 1;
      return { removedByTtl: 0 };
    });
    const lifecycle = new RuntimeLifecycle({
      responseStore,
      sessions: createSessionManager(),
      tracker: new ActiveResourceTracker(),
      options: { intervalMs: 500 },
    });
    lifecycle.runCleanup();
    lifecycle.runCleanup();
    expect(maxConcurrent).toBe(1);
  });
});
