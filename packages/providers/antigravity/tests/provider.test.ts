import type { AgentExecutionInput, AgentEvent } from "@agent-runtime-gateway/core";
import { InMemorySessionStore } from "@agent-runtime-gateway/core";
import type { ContentBlock } from "@agent-runtime-gateway/provider-antigravity/acp";
import type { AcpSessionRecord } from "../src/session-store.js";
import type {
  AgentTurnResult,
  RunAgentTurnOptions,
  SessionConfigOption,
} from "@agent-runtime-gateway/provider-antigravity/acp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityProvider, type AntigravityAcpClient } from "../src/provider.js";

class FakeAcpClient implements AntigravityAcpClient {
  public readonly calls: string[] = [];
  public lastBlocks?: readonly ContentBlock[];
  public onPrompt: (options: RunAgentTurnOptions) => Promise<AgentTurnResult> = (
    options,
  ) => {
    options.onEvent?.("agent_message_chunk", {
      content: { type: "text", text: "ACP response" },
    });
    return Promise.resolve({
      prompt: { stopReason: "end_turn" },
      agentText: "ACP response",
      thoughtText: "",
    });
  };

  public connect(): Promise<void> {
    this.calls.push("connect");
    return Promise.resolve();
  }

  public createSession(cwd: string): Promise<{ sessionId: string }> {
    this.calls.push(`new:${cwd}`);
    return Promise.resolve({ sessionId: "acp-session-1" });
  }

  public resumeSession(
    sessionId: string,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    this.calls.push(`resume:${sessionId}:${cwd}`);
    return Promise.resolve({ sessionId });
  }

  public listSessions(): Promise<{ sessions: readonly { sessionId: string }[] }> {
    this.calls.push("list");
    return Promise.resolve({ sessions: [] });
  }

  public setSessionConfig(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<readonly SessionConfigOption[]> {
    this.calls.push(`config:${sessionId}:${configId}:${String(value)}`);
    return Promise.resolve([]);
  }

  public prompt(
    sessionId: string,
    blocks: Parameters<AntigravityAcpClient["prompt"]>[1],
    options: RunAgentTurnOptions,
  ): Promise<AgentTurnResult> {
    this.calls.push(`prompt:${sessionId}`);
    this.lastBlocks = blocks;
    return this.onPrompt(options);
  }

  public cancelTurn(sessionId: string): void {
    this.calls.push(`cancel:${sessionId}`);
  }

  public closeSession(sessionId: string): Promise<void> {
    this.calls.push(`close:${sessionId}`);
    return Promise.resolve();
  }

  public terminate(): Promise<void> {
    this.calls.push("terminate");
    return Promise.resolve();
  }
}

function input(overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return {
    credential: { type: "local", value: "" },
    model: "antigravity:gemini-3.8-flash",
    sessionId: "gateway-session-1",
    message: "Hello",
    workingDirectory: "/workspace",
    ...overrides,
  };
}

describe("AntigravityProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the namespaced ACP models without starting an agent process", async () => {
    const clientFactory = vi.fn(() => new FakeAcpClient());
    const provider = new AntigravityProvider({ clientFactory });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      "antigravity:gemini-3.8-flash",
      "antigravity:claude-sonnet-4-6",
      "antigravity:claude-opus-4-6-thinking",
      "antigravity:gpt-oss-120b-medium",
    ]);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("appends image content blocks after the text block", async () => {
    const client = new FakeAcpClient();
    const provider = new AntigravityProvider({ clientFactory: () => client });

    await provider.execute(
      input({
        message: "Describe these images",
        images: [
          { mimeType: "image/png", data: "AAAAAFBO" },
          { mimeType: "image/jpeg", data: "AAABAAA" },
        ],
      }),
    );

    expect(client.lastBlocks).toEqual([
      { type: "text", text: "Describe these images" },
      { type: "image", mimeType: "image/png", data: "AAAAAFBO" },
      { type: "image", mimeType: "image/jpeg", data: "AAABAAA" },
    ]);
  });

  it("sends a text-only block list when no images are provided", async () => {
    const client = new FakeAcpClient();
    const provider = new AntigravityProvider({ clientFactory: () => client });

    await provider.execute(input());

    expect(client.lastBlocks).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("streams ACP message chunks and resumes the mapped session on the next run", async () => {
    const clients: FakeAcpClient[] = [];
    const provider = new AntigravityProvider({
      clientFactory: () => {
        const client = new FakeAcpClient();
        clients.push(client);
        return client;
      },
    });

    const firstRun = await provider.execute(input());
    const firstEvents: AgentEvent[] = [];
    for await (const event of firstRun.events) {
      firstEvents.push(event);
    }
    const firstResult = await firstRun.wait();

    expect(firstResult).toEqual({
      status: "completed",
      output: { text: "ACP response" },
    });
    expect(
      firstEvents.some(
        (event) => event.type === "message.delta" && event.delta === "ACP response",
      ),
    ).toBe(true);
    expect(clients[0]?.calls).toContain("config:acp-session-1:model:gemini-3.8-flash");
    expect(clients[0]?.calls).toContain("terminate");

    const secondRun = await provider.execute(input({ message: "Follow up" }));
    await secondRun.wait();

    expect(clients[1]?.calls).toContain("resume:acp-session-1:/workspace");
    expect(clients[1]?.calls).toContain("prompt:acp-session-1");
  });

  it("publishes ACP deltas before the prompt turn finishes", async () => {
    let emitDelta: (() => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    const client = new FakeAcpClient();
    client.onPrompt = (options) =>
      new Promise<AgentTurnResult>((resolve) => {
        emitDelta = () =>
          options.onEvent?.("agent_message_chunk", {
            content: { type: "text", text: "first delta" },
          });
        finishPrompt = () =>
          resolve({
            prompt: { stopReason: "end_turn" },
            agentText: "first delta",
            thoughtText: "",
          });
      });
    const provider = new AntigravityProvider({ clientFactory: () => client });
    const run = await provider.execute(input());
    const iterator = run.events[Symbol.asyncIterator]();

    await iterator.next();
    const deltaPromise = iterator.next();
    emitDelta?.();
    const delta = await deltaPromise;
    let resultSettled = false;
    const resultPromise = run.wait().then((result) => {
      resultSettled = true;
      return result;
    });

    expect(delta).toMatchObject({
      done: false,
      value: { type: "message.delta", delta: "first delta" },
    });
    expect(resultSettled).toBe(false);

    finishPrompt?.();
    await expect(resultPromise).resolves.toMatchObject({ status: "completed" });
  });

  it("maps cancellation to ACP session/cancel and a cancelled AgentResult", async () => {
    let finishPrompt: ((result: AgentTurnResult) => void) | undefined;
    const client = new FakeAcpClient();
    client.onPrompt = () =>
      new Promise<AgentTurnResult>((resolve) => {
        finishPrompt = resolve;
      });
    client.cancelTurn = (sessionId: string): void => {
      client.calls.push(`cancel:${sessionId}`);
      finishPrompt?.({
        prompt: { stopReason: "cancelled" },
        agentText: "",
        thoughtText: "",
      });
    };
    const provider = new AntigravityProvider({ clientFactory: () => client });
    const run = await provider.execute(input());

    await run.cancel();
    const result = await run.wait();

    expect(client.calls).toContain("cancel:acp-session-1");
    expect(result.status).toBe("cancelled");
    expect(client.calls).toContain("terminate");
  });

  it("rejects an overlapping execution for the same gateway session", async () => {
    let finishPrompt: ((result: AgentTurnResult) => void) | undefined;
    const client = new FakeAcpClient();
    client.onPrompt = () =>
      new Promise<AgentTurnResult>((resolve) => {
        finishPrompt = resolve;
      });
    client.cancelTurn = (sessionId: string): void => {
      client.calls.push(`cancel:${sessionId}`);
      finishPrompt?.({
        prompt: { stopReason: "cancelled" },
        agentText: "",
        thoughtText: "",
      });
    };
    const provider = new AntigravityProvider({ clientFactory: () => client });
    const firstRun = await provider.execute(input());

    await expect(provider.execute(input())).rejects.toThrow(/turn in progress/i);
    await firstRun.cancel();
    await expect(firstRun.wait()).resolves.toMatchObject({ status: "cancelled" });
  });

  it("maps an aborted request signal to ACP cancellation", async () => {
    let finishPrompt: ((result: AgentTurnResult) => void) | undefined;
    const client = new FakeAcpClient();
    client.onPrompt = () =>
      new Promise<AgentTurnResult>((resolve) => {
        finishPrompt = resolve;
      });
    client.cancelTurn = (sessionId: string): void => {
      client.calls.push(`cancel:${sessionId}`);
      finishPrompt?.({
        prompt: { stopReason: "cancelled" },
        agentText: "",
        thoughtText: "",
      });
    };
    const provider = new AntigravityProvider({ clientFactory: () => client });
    const controller = new AbortController();
    const run = await provider.execute(input({ signal: controller.signal }));

    controller.abort();

    await expect(run.wait()).resolves.toMatchObject({ status: "cancelled" });
    expect(client.calls).toContain("cancel:acp-session-1");
    expect(client.calls).toContain("terminate");
  });

  it("terminates the ACP process when the agent ignores cancellation", async () => {
    let finishPrompt: ((result: AgentTurnResult) => void) | undefined;
    const client = new FakeAcpClient();
    client.onPrompt = () =>
      new Promise<AgentTurnResult>((resolve) => {
        finishPrompt = resolve;
      });
    client.cancelTurn = (sessionId: string): void => {
      client.calls.push(`cancel:${sessionId}`);
    };
    client.terminate = (): Promise<void> => {
      client.calls.push("terminate");
      finishPrompt?.({
        prompt: { stopReason: "cancelled" },
        agentText: "",
        thoughtText: "",
      });
      return Promise.resolve();
    };
    const provider = new AntigravityProvider({
      clientFactory: () => client,
      cancelGraceMs: 5,
    });
    const controller = new AbortController();
    const run = await provider.execute(input({ signal: controller.signal }));

    controller.abort();

    await expect(run.wait()).resolves.toMatchObject({ status: "cancelled" });
    expect(client.calls).toContain("cancel:acp-session-1");
    expect(client.calls).toContain("terminate");
  });

  it("rejects non-local credentials before spawning the ACP process", async () => {
    const clientFactory = vi.fn(() => new FakeAcpClient());
    const provider = new AntigravityProvider({ clientFactory });

    await expect(
      provider.execute(
        input({ credential: { type: "api_key", value: "not-forwarded" } }),
      ),
    ).rejects.toThrow(/local/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("closePersistedAcpSessions closes mapped ids and ids from listSessions", async () => {
    class ListCloseFake extends FakeAcpClient {
      public override listSessions(): Promise<{
        sessions: readonly { sessionId: string }[];
      }> {
        this.calls.push("list");
        return Promise.resolve({ sessions: [{ sessionId: "acp-from-list" }] });
      }
    }

    const mem = new InMemorySessionStore<AcpSessionRecord>();
    await mem.set("antigravity", "gw-x", {
      acpSessionId: "acp-mapped",
      touchedAt: Date.now(),
    });

    const provider = new AntigravityProvider({
      clientFactory: () => new ListCloseFake(),
      sessionStore: mem,
      defaultWorkingDirectory: "/tmp/ag-clear-test",
    });

    const report = await provider.closePersistedAcpSessions();

    expect(report.mapped_acp_ids_count).toBe(1);
    expect(report.listed_acp_sessions_count).toBe(1);
    expect(report.acp_sessions_closed).toBe(2);
    expect(report.acp_close_failures).toBe(0);
  });

  it("rejects tool_choice for non-existent function before execution", async () => {
    const client = new FakeAcpClient();
    const provider = new AntigravityProvider({
      clientFactory: () => client,
    });

    await expect(
      provider.execute(
        input({
          tools: [{ name: "declared_tool", parameters: {} }],
          toolChoice: { type: "function", function: { name: "missing_tool" } },
        }),
      ),
    ).rejects.toThrow("Requested tool 'missing_tool' in tool_choice was not found in declared tools.");
  });

  it("appends anti-parallel instruction when parallelToolCalls is false", async () => {
    const client = new FakeAcpClient();
    const provider = new AntigravityProvider({
      clientFactory: () => client,
    });

    const run = await provider.execute(
      input({
        tools: [{ name: "my_tool", parameters: {} }],
        parallelToolCalls: false,
      }),
    );
    await run.wait();

    const textBlocks = (client.lastBlocks ?? []).filter((b: any) => b.type === "text");
    expect(textBlocks[0].text).toContain("Parallel tool calling is disabled");
  });

  it("rejects response when tool_choice='required' and no tool is invoked", async () => {
    const client = new FakeAcpClient();
    const provider = new AntigravityProvider({
      clientFactory: () => client,
    });

    const run = await provider.execute(
      input({
        tools: [{ name: "my_tool", parameters: {} }],
        toolChoice: "required",
      }),
    );

    const result = await run.wait();
    expect(result.status).toBe("failed");
  });
});
