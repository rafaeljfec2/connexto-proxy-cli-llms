import type { Run } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { CursorProvider } from "../src/provider.js";

describe("CursorProvider run adapter", () => {
  it("shares a single wait result between wait() and terminal stream events", async () => {
    const wait = vi.fn(() =>
      Promise.resolve({
        id: "run_1",
        status: "finished" as const,
        result: "ok",
      }),
    );

    function* stream() {
      yield {
        type: "assistant" as const,
        agent_id: "agent_1",
        run_id: "run_1",
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "ok" }],
        },
      };
    }

    const run = {
      id: "run_1",
      stream: () => stream(),
      wait,
      cancel: vi.fn(() => Promise.resolve(undefined)),
    };

    const provider = new CursorProvider({
      client: {
        listModels: vi.fn(),
        createLocalAgent: vi.fn(() =>
          Promise.resolve({
            agentId: "agent_1",
            send: vi.fn(() => Promise.resolve(run as unknown as Run)),
            close: vi.fn(),
          } as never),
        ),
        resumeLocalAgent: vi.fn(),
      },
    });

    const agentRun = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "session-1",
      message: "hello",
    });

    const eventTypes: string[] = [];
    for await (const event of agentRun.events) {
      eventTypes.push(event.type);
    }

    const result = await agentRun.wait();

    expect(eventTypes).toEqual(["run.started", "message.delta", "run.completed"]);
    expect(result.status).toBe("completed");
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
