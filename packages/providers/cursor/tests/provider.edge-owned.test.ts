import { describe, expect, it, vi } from "vitest";
import { CursorProvider } from "../src/provider.js";

describe("CursorProvider edge_owned execution", () => {
  it("forwards SDK client tool calls without acquiring a local-runtime agent", async () => {
    const createLocalAgent = vi.fn();
    const edgeOwnedRunner = vi.fn(() =>
      Promise.resolve({
        agentId: "agent_edge",
        runId: "run_edge",
        stream: (async function* () {
          await Promise.resolve();
          yield {
            type: "tool_call" as const,
            toolCall: { name: "write", arguments: { path: "note.txt" } },
          };
          yield {
            type: "done" as const,
            finalText: "",
            toolCalls: [{ name: "write", arguments: { path: "note.txt" } }],
          };
        })(),
      }),
    );
    const provider = new CursorProvider({
      client: {
        listModels: vi.fn(),
        createLocalAgent,
        resumeLocalAgent: vi.fn(),
      },
      edgeOwnedRunner,
    });

    const run = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "sess-1",
      message: "hello",
      workingDirectory: "/client/repository",
      cursor: {
        mode: "edge_owned",
        promptMode: "agent",
        requiresLocalTool: false,
        clientTools: [{ name: "write", parameters: { type: "object" } }],
      },
    });

    expect(edgeOwnedRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-key",
        model: "composer-2.5",
        prompt: "hello",
        workingDirectory: "/client/repository",
        clientTools: [{ name: "write", parameters: { type: "object" } }],
      }),
    );
    expect(createLocalAgent).not.toHaveBeenCalled();
    const events = [];
    for await (const event of run.events) events.push(event);
    const result = await run.wait();
    expect(result.status).toBe("completed");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.call", toolName: "write" }),
    );
  });

  it("cancels an edge SDK run when the request aborts before its stream is consumed", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => Promise.resolve());
    const onExecutionEnd = vi.fn();
    const provider = new CursorProvider({
      edgeOwnedRunner: vi.fn(() =>
        Promise.resolve({
          agentId: "agent_edge",
          runId: "run_edge",
          stream: (async function* () {
            await Promise.resolve();
            yield { type: "done" as const, finalText: "", toolCalls: [] };
          })(),
          cancel,
        }),
      ),
      executionGuard: { onExecutionEnd },
    });

    await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "sess-aborted",
      message: "hello",
      signal: controller.signal,
      cursor: { mode: "edge_owned", promptMode: "agent" },
    });
    controller.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());

    expect(onExecutionEnd).toHaveBeenCalledOnce();
  });
});
