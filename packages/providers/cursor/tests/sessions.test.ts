import { describe, expect, it, vi } from "vitest";
import type { CursorClient } from "../src/client.js";
import { CursorSessionManager } from "../src/sessions.js";

describe("CursorSessionManager", () => {
  it("creates then resumes agents for the same session id", async () => {
    const agent = {
      agentId: "agent-1",
      send: vi.fn(),
      close: vi.fn(),
    };

    const createLocalAgent = vi.fn(() => Promise.resolve(agent as never));
    const resumeLocalAgent = vi.fn(() => Promise.resolve(agent as never));

    const client: CursorClient = {
      listModels: vi.fn(),
      createLocalAgent,
      resumeLocalAgent,
    };

    const sessions = new CursorSessionManager(client);
    const params = {
      apiKey: "key",
      model: "composer-2.5",
      name: "test",
      workingDirectory: process.cwd(),
    };

    await sessions.acquireAgent("session-a", params);
    await sessions.acquireAgent("session-a", params);

    expect(createLocalAgent).toHaveBeenCalledTimes(1);
    expect(resumeLocalAgent).toHaveBeenCalledTimes(1);
  });
});
