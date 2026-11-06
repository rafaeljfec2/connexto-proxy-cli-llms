import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore } from "@agent-runtime-gateway/core";
import { CursorSessionManager, type CursorSessionRecord } from "../src/sessions.js";
import type { CursorClient } from "../src/client.js";
import type { SDKAgent } from "@cursor/sdk";

function createMockClient() {
  const createLocalAgent = vi.fn().mockImplementation((params) => {
    return Promise.resolve({
      agentId: "agent-created-" + Math.random().toString(36).substring(7),
      name: params.name,
    } as unknown as SDKAgent);
  });

  const resumeLocalAgent = vi.fn().mockImplementation((params) => {
    return Promise.resolve({
      agentId: params.agentId,
      name: params.name,
    } as unknown as SDKAgent);
  });

  return {
    client: {
      createLocalAgent,
      resumeLocalAgent,
    } as unknown as CursorClient,
    createLocalAgent,
    resumeLocalAgent,
  };
}

describe("CursorSessionManager with Persistent SessionStore", () => {
  it("persists sessions and resumes them across manager instances (restart simulation)", async () => {
    const store = new InMemorySessionStore<CursorSessionRecord>();
    const mock1 = createMockClient();

    const manager1 = new CursorSessionManager(mock1.client, { store });

    const agent1 = await manager1.acquireAgent("session-123", {
      apiKey: "key-1",
      model: "composer-2.5",
      name: "test-agent",
      workingDirectory: "/tmp",
    });

    expect(mock1.createLocalAgent).toHaveBeenCalledTimes(1);
    expect(mock1.resumeLocalAgent).toHaveBeenCalledTimes(0);
    const originalAgentId = agent1.agentId;

    // Verify it was persisted to store under "cursor" namespace
    const storedRecord = await store.get("cursor", "session-123");
    expect(storedRecord).toBeDefined();
    expect(storedRecord?.agentId).toBe(originalAgentId);

    // Simulate restart: manager2 has clean memory but shares the same store
    const mock2 = createMockClient();
    const manager2 = new CursorSessionManager(mock2.client, { store });

    const agent2 = await manager2.acquireAgent("session-123", {
      apiKey: "key-1",
      model: "composer-2.5",
      name: "test-agent",
      workingDirectory: "/tmp",
    });

    // Should resume the existing agent, NOT create a new one!
    expect(mock2.createLocalAgent).toHaveBeenCalledTimes(0);
    expect(mock2.resumeLocalAgent).toHaveBeenCalledTimes(1);
    expect(agent2.agentId).toBe(originalAgentId);
  });

  it("removes session from store on forget", async () => {
    const store = new InMemorySessionStore<CursorSessionRecord>();
    const mock = createMockClient();
    const manager = new CursorSessionManager(mock.client, { store });

    await manager.acquireAgent("sess-del", {
      apiKey: "key-1",
      model: "composer-2.5",
      name: "test-agent",
      workingDirectory: "/tmp",
    });

    expect(await store.exists("cursor", "sess-del")).toBe(true);

    manager.forget("sess-del");
    // Give async void promise tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(await store.exists("cursor", "sess-del")).toBe(false);
  });
});
