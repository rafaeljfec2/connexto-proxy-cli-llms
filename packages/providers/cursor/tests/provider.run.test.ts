import type { Run } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { CursorProvider } from "../src/provider.js";

function createProviderWithRun(run: Run): CursorProvider {
  return new CursorProvider({
    client: {
      listModels: vi.fn(),
      createLocalAgent: vi.fn(() =>
        Promise.resolve({
          agentId: "agent_1",
          send: vi.fn(() => Promise.resolve(run)),
          close: vi.fn(),
        } as never),
      ),
      resumeLocalAgent: vi.fn(),
    },
  });
}

function createTerminalAwareRun() {
  let status: Run["status"] = "running";
  async function* stream() {
    await Promise.resolve();
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

  const cancel = vi.fn(() => {
    status = "cancelled";
    return Promise.resolve();
  });
  const run = {
    id: "run_1",
    get status() {
      return status;
    },
    stream,
    wait: vi.fn(() => {
      status = "finished";
      return Promise.resolve({
        id: "run_1",
        status: "finished" as const,
        result: "ok",
      });
    }),
    cancel,
  } as unknown as Run;

  return { run, cancel };
}

describe("CursorProvider run adapter", () => {
  it("keeps the base Composer model out of the fast variant for local runtime", async () => {
    const run = createTerminalAwareRun().run;
    const send = vi.fn(() => Promise.resolve(run));
    const provider = new CursorProvider({
      client: {
        listModels: vi.fn(),
        createLocalAgent: vi.fn(() =>
          Promise.resolve({ agentId: "agent_local", send, close: vi.fn() } as never),
        ),
        resumeLocalAgent: vi.fn(),
      },
    });

    const agentRun = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "session-base-composer",
      message: "hello",
    });
    const events = [];
    for await (const event of agentRun.events) events.push(event.type);
    await agentRun.wait();

    expect(events).toContain("run.completed");
    expect(send).toHaveBeenCalledWith("hello", {
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    });
  });

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

  it("calls the SDK cancel operation once when signal and run cancellation race", async () => {
    const controller = new AbortController();
    const mocked = createTerminalAwareRun();
    const provider = createProviderWithRun(mocked.run);
    const agentRun = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "cancel-once-session",
      message: "hello",
      signal: controller.signal,
    });

    controller.abort();
    await agentRun.cancel();

    expect(mocked.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the SDK run when the consumer exits its event stream early", async () => {
    const mocked = createTerminalAwareRun();
    const provider = createProviderWithRun(mocked.run);
    const agentRun = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "early-stream-exit-session",
      message: "hello",
    });

    for await (const event of agentRun.events) {
      expect(event.type).toBe("run.started");
      break;
    }

    await vi.waitFor(() => expect(mocked.cancel).toHaveBeenCalledTimes(1));
  });

  it("does not cancel a completed SDK run or retain its abort listener", async () => {
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const mocked = createTerminalAwareRun();
    const provider = createProviderWithRun(mocked.run);
    const agentRun = await provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "completed-session",
      message: "hello",
      signal: controller.signal,
    });

    for await (const event of agentRun.events) expect(event).toBeDefined();
    await agentRun.wait();
    controller.abort();
    await agentRun.cancel();

    expect(mocked.cancel).not.toHaveBeenCalled();
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not send a Cursor message when the request aborts during agent acquisition", async () => {
    let resolveAgent: (agent: {
      readonly agentId: string;
      send: () => Promise<Run>;
      close: () => void;
    }) => void = () => undefined;
    const agentPromise = new Promise<{
      readonly agentId: string;
      send: () => Promise<Run>;
      close: () => void;
    }>((resolve) => {
      resolveAgent = resolve;
    });
    const send = vi.fn(() => Promise.resolve(createTerminalAwareRun().run));
    const createLocalAgent = vi.fn(() => agentPromise);
    const provider = new CursorProvider({
      client: {
        listModels: vi.fn(),
        createLocalAgent,
        resumeLocalAgent: vi.fn(),
      } as never,
    });
    const controller = new AbortController();
    const execution = provider.execute({
      credential: { type: "cursor_api_key", value: "test-key" },
      model: "composer-2.5",
      sessionId: "acquiring-session",
      message: "hello",
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(createLocalAgent).toHaveBeenCalled());
    controller.abort();
    resolveAgent({
      agentId: "agent_1",
      send,
      close: () => undefined,
    });

    await expect(execution).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
