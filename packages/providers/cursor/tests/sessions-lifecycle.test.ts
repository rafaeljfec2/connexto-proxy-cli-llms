import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CursorClient } from "../src/client.js";
import { CursorSessionManager } from "../src/sessions.js";

function createClient() {
  const agent = { agentId: "agent-1", send: vi.fn(), close: vi.fn() };
  const client: CursorClient = {
    listModels: vi.fn(),
    createLocalAgent: vi.fn(() => Promise.resolve(agent as never)),
    resumeLocalAgent: vi.fn(() => Promise.resolve(agent as never)),
  };
  return { client, agent };
}

describe("CursorSessionManager lifecycle", () => {
  const params = {
    apiKey: "key",
    model: "composer-2.5",
    name: "test",
    workingDirectory: process.cwd(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires inactive sessions after TTL", async () => {
    const { client } = createClient();
    const sessions = new CursorSessionManager(client, { ttlMs: 1_000 });
    await sessions.acquireAgent("session-a", params);
    expect(sessions.getRemoteAgentId("session-a")).toBe("agent-1");
    vi.advanceTimersByTime(2_000);
    const removed = sessions.cleanupInactive(Date.now(), () => false);
    expect(removed).toBe(1);
    expect(sessions.getRemoteAgentId("session-a")).toBeUndefined();
  });

  it("does not expire protected active sessions", async () => {
    const { client } = createClient();
    const sessions = new CursorSessionManager(client, { ttlMs: 1_000 });
    await sessions.acquireAgent("session-a", params);
    vi.advanceTimersByTime(2_000);
    const removed = sessions.cleanupInactive(Date.now(), (id) => id === "session-a");
    expect(removed).toBe(0);
    expect(sessions.getRemoteAgentId("session-a")).toBe("agent-1");
  });

  it("renews retention on activity", async () => {
    const { client } = createClient();
    const sessions = new CursorSessionManager(client, { ttlMs: 1_000 });
    await sessions.acquireAgent("session-a", params);
    vi.advanceTimersByTime(800);
    await sessions.acquireAgent("session-a", params);
    vi.advanceTimersByTime(500);
    const removed = sessions.cleanupInactive(Date.now(), () => false);
    expect(removed).toBe(0);
    vi.advanceTimersByTime(1_000);
    const removedLater = sessions.cleanupInactive(Date.now(), () => false);
    expect(removedLater).toBe(1);
  });

  it("keeps sessions for different keys isolated", async () => {
    const { client } = createClient();
    const sessions = new CursorSessionManager(client, { ttlMs: 1_000 });
    await sessions.acquireAgent("session-a", params);
    await sessions.acquireAgent("session-b", params);
    vi.advanceTimersByTime(2_000);
    sessions.cleanupInactive(Date.now(), () => false);
    expect(sessions.getRemoteAgentId("session-a")).toBeUndefined();
    expect(sessions.getRemoteAgentId("session-b")).toBeUndefined();
  });
});
