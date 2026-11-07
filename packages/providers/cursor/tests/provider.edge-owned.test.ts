import { describe, expect, it, vi } from "vitest";

vi.mock("../src/cursor-sdk.js", () => ({
  createCursorSdkCompletion: vi.fn(() =>
    Promise.resolve({
      agentId: "agent_edge",
      runId: "run_edge",
      stream: (function* () {
        yield { type: "text", text: "ok" };
        yield { type: "done", finalText: "ok", toolCalls: [] };
      })(),
    }),
  ),
}));

import { CursorProvider } from "../src/provider.js";
import { createCursorSdkCompletion } from "../src/cursor-sdk.js";

describe("CursorProvider edge_owned execution", () => {
  it("uses remote SDK completion instead of createLocalAgent", async () => {
    const createLocalAgent = vi.fn();
    const provider = new CursorProvider({
      client: {
        listModels: vi.fn(),
        createLocalAgent,
        resumeLocalAgent: vi.fn(),
      },
    });

    const run = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "sess-1",
      message: "hello",
      cursor: { mode: "edge_owned", promptMode: "agent" },
    });

    expect(createCursorSdkCompletion).toHaveBeenCalledTimes(1);
    expect(createLocalAgent).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drain like HTTP handlers
    for await (const _ of run.events) {
      /* drain */
    }
    const result = await run.wait();
    expect(result.status).toBe("completed");
    expect(result.output?.text).toBe("ok");
  });
});
