import type { AgentOptions, RunResult, RunStatus, SDKMessage } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createCursorSdkInProcessCompletion,
  type CursorSdkInProcessDependencies,
} from "../src/sdk-inprocess-runner.js";
import type { CursorTextEvent } from "../src/engine/types.js";

describe("createCursorSdkInProcessCompletion", () => {
  it("returns client-owned tool calls and cancels the SDK run before resolving the callback", async () => {
    let options: AgentOptions | undefined;
    let runStatus: RunStatus = "running";
    const toolCallMessage: SDKMessage = {
      type: "tool_call",
      agent_id: "agent-1",
      run_id: "run-1",
      call_id: "call-1",
      name: "mcp",
      status: "running",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "write",
        args: { path: "note.txt", fileText: "hello" },
      },
    };
    const run = {
      id: "run-1",
      get status() {
        return runStatus;
      },
      async *stream(): AsyncGenerator<SDKMessage> {
        const writeTool = options?.local?.customTools?.write;
        if (!writeTool) throw new Error("Client write tool was not registered");
        const toolResult = writeTool.execute(
          { path: "note.txt", fileText: "hello" },
          { toolCallId: "call-1" },
        );
        yield toolCallMessage;
        await toolResult;
      },
      wait(): Promise<RunResult> {
        return Promise.resolve({
          id: "run-1",
          status: runStatus === "running" ? "cancelled" : runStatus,
        });
      },
      cancel: vi.fn(() => {
        runStatus = "cancelled";
        return Promise.resolve();
      }),
    };
    const closeAgent = vi.fn();
    const agent = {
      agentId: "agent-1",
      send: vi.fn(() => Promise.resolve(run)),
      close: closeAgent,
    };
    const deleteAgent = vi.fn(() => Promise.resolve());
    const dependencies: CursorSdkInProcessDependencies = {
      createAgent: vi.fn((agentOptions) => {
        options = agentOptions;
        return Promise.resolve(agent);
      }),
      deleteAgent,
    };

    const completion = await createCursorSdkInProcessCompletion(
      {
        apiKey: "cursor-key",
        model: "composer-2.5",
        agentName: "gateway-test",
        prompt: "Create note.txt",
        workingDirectory: "/ide/project",
        clientTools: [
          {
            name: "write",
            description: "Write a client-owned file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
      dependencies,
    );

    const events: CursorTextEvent[] = [];
    for await (const event of completion.stream) events.push(event);

    expect(options?.tools).toEqual(["mcp"]);
    expect(options?.mcpServers).toEqual({});
    expect(options?.local?.settingSources).toEqual([]);
    expect(options?.local?.cwd).not.toBe("/ide/project");
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: { name: "write", arguments: { path: "note.txt", fileText: "hello" } },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "",
      toolCalls: [
        { name: "write", arguments: { path: "note.txt", fileText: "hello" } },
      ],
    });
    expect(closeAgent).toHaveBeenCalledOnce();
    expect(deleteAgent).toHaveBeenCalledWith("agent-1");
  });

  it("disables all tools for an ask request without a client tool inventory", async () => {
    let options: AgentOptions | undefined;
    let runStatus: RunStatus = "finished";
    const run = {
      id: "run-2",
      get status() {
        return runStatus;
      },
      async *stream(): AsyncGenerator<SDKMessage> {
        await Promise.resolve();
        yield {
          type: "assistant",
          agent_id: "agent-2",
          run_id: "run-2",
          message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        };
      },
      wait(): Promise<RunResult> {
        return Promise.resolve({
          id: "run-2",
          status: runStatus === "running" ? "cancelled" : runStatus,
          result: "Hello",
        });
      },
      cancel: vi.fn(() => {
        runStatus = "cancelled";
        return Promise.resolve();
      }),
    };
    const deleteAgent = vi.fn(() => Promise.resolve());
    const agent = {
      agentId: "agent-2",
      send: vi.fn(() => Promise.resolve(run)),
      close: vi.fn(),
    };
    const dependencies: CursorSdkInProcessDependencies = {
      createAgent: vi.fn((agentOptions) => {
        options = agentOptions;
        return Promise.resolve(agent);
      }),
      deleteAgent,
    };

    const completion = await createCursorSdkInProcessCompletion(
      {
        apiKey: "cursor-key",
        model: "composer-2.5",
        agentName: "gateway-test",
        prompt: "Say hello",
        clientTools: [],
      },
      dependencies,
    );
    const events: CursorTextEvent[] = [];
    for await (const event of completion.stream) events.push(event);

    expect(options?.tools).toEqual([]);
    expect(options?.local?.customTools).toBeUndefined();
    expect(events).toContainEqual({ type: "text", text: "Hello" });
    expect(events.at(-1)).toEqual({ type: "done", finalText: "Hello", toolCalls: [] });
    expect(run.cancel).not.toHaveBeenCalled();
    expect(deleteAgent).toHaveBeenCalledWith("agent-2");
  });

  it("cancels and cleans up an agent when the stream is never consumed", async () => {
    const run = {
      id: "run-3",
      status: "running" as const,
      stream: vi.fn(),
      wait: vi.fn(),
      cancel: vi.fn(() => Promise.resolve()),
    };
    const closeAgent = vi.fn();
    const deleteAgent = vi.fn(() => Promise.resolve());
    const dependencies: CursorSdkInProcessDependencies = {
      createAgent: vi.fn(() =>
        Promise.resolve({
          agentId: "agent-3",
          send: () => Promise.resolve(run),
          close: closeAgent,
        }),
      ),
      deleteAgent,
    };

    const completion = await createCursorSdkInProcessCompletion(
      {
        apiKey: "cursor-key",
        model: "composer-2.5",
        agentName: "gateway-test",
        prompt: "Say hello",
        clientTools: [],
      },
      dependencies,
    );

    await completion.cancel?.();

    expect(run.stream).not.toHaveBeenCalled();
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(closeAgent).toHaveBeenCalledOnce();
    expect(deleteAgent).toHaveBeenCalledWith("agent-3");
  });

  it("closes a pending SDK send and cancels its run after request abort", async () => {
    const controller = new AbortController();
    let runStatus: RunStatus = "running";
    const run = {
      id: "run-5",
      get status() {
        return runStatus;
      },
      async *stream(): AsyncGenerator<SDKMessage> {
        await Promise.resolve();
        yield {
          type: "status",
          agent_id: "agent-5",
          run_id: "run-5",
          status: "RUNNING",
        };
      },
      wait: vi.fn(() => Promise.resolve({ id: "run-5", status: "cancelled" as const })),
      cancel: vi.fn(() => {
        runStatus = "cancelled";
        return Promise.resolve();
      }),
    };
    let resolveRun: ((value: typeof run) => void) | undefined;
    const closeAgent = vi.fn();
    const deleteAgent = vi.fn(() => Promise.resolve());
    const agent = {
      agentId: "agent-5",
      send: vi.fn(
        () =>
          new Promise<typeof run>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      close: closeAgent,
    };
    const dependencies: CursorSdkInProcessDependencies = {
      createAgent: vi.fn(() => Promise.resolve(agent)),
      deleteAgent,
    };

    const completionPromise = createCursorSdkInProcessCompletion(
      {
        apiKey: "cursor-key",
        model: "composer-2.5",
        agentName: "gateway-test",
        prompt: "Say hello",
        clientTools: [],
        signal: controller.signal,
      },
      dependencies,
    );
    await vi.waitFor(() => expect(agent.send).toHaveBeenCalledOnce());
    controller.abort();
    expect(closeAgent).toHaveBeenCalledOnce();
    resolveRun?.(run);

    await expect(completionPromise).rejects.toThrow();
    expect(run.cancel).toHaveBeenCalledOnce();
    expect(deleteAgent).toHaveBeenCalledWith("agent-5");
  });

  it("forwards every client tool in one SDK assistant tool batch", async () => {
    let runStatus: RunStatus = "running";
    const run = {
      id: "run-4",
      get status() {
        return runStatus;
      },
      async *stream(): AsyncGenerator<SDKMessage> {
        await Promise.resolve();
        yield {
          type: "assistant",
          agent_id: "agent-4",
          run_id: "run-4",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call-read",
                name: "mcp",
                input: {
                  providerIdentifier: "custom-user-tools",
                  toolName: "read",
                  args: { path: "a.txt" },
                },
              },
              {
                type: "tool_use",
                id: "call-write",
                name: "mcp",
                input: {
                  providerIdentifier: "custom-user-tools",
                  toolName: "write",
                  args: { path: "b.txt", fileText: "hello" },
                },
              },
            ],
          },
        };
      },
      wait: vi.fn(() => Promise.resolve({ id: "run-4", status: "cancelled" as const })),
      cancel: vi.fn(() => {
        runStatus = "cancelled";
        return Promise.resolve();
      }),
    };
    const agent = {
      agentId: "agent-4",
      send: vi.fn(() => Promise.resolve(run)),
      close: vi.fn(),
    };
    const dependencies: CursorSdkInProcessDependencies = {
      createAgent: vi.fn(() => Promise.resolve(agent)),
      deleteAgent: vi.fn(() => Promise.resolve()),
    };

    const completion = await createCursorSdkInProcessCompletion(
      {
        apiKey: "cursor-key",
        model: "composer-2.5",
        agentName: "gateway-test",
        prompt: "Read and write files",
        clientTools: [{ name: "read" }, { name: "write" }],
      },
      dependencies,
    );
    const events: CursorTextEvent[] = [];
    for await (const event of completion.stream) events.push(event);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", toolCall: { name: "read", arguments: { path: "a.txt" } } },
      {
        type: "tool_call",
        toolCall: { name: "write", arguments: { path: "b.txt", fileText: "hello" } },
      },
    ]);
    expect(run.cancel).toHaveBeenCalledOnce();
  });
});
