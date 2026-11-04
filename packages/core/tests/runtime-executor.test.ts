import {
  ProviderExecutionError,
  ProviderNotFoundError,
  ProviderRegistry,
  ProviderRouter,
  RuntimeExecutor,
  type AgentExecutionInput,
} from "@agent-runtime-gateway/core";
import { describe, expect, it } from "vitest";
import { createCompletedRun, createStubProvider } from "./helpers/stub-provider.js";

const baseInput: AgentExecutionInput = {
  credential: { type: "test", value: "redacted" },
  model: "stub-model",
  sessionId: "session-1",
  message: "hello",
};

describe("RuntimeExecutor", () => {
  function createExecutor(providers: ReturnType<typeof createStubProvider>[]) {
    const registry = new ProviderRegistry();
    for (const provider of providers) {
      registry.register(provider);
    }
    return new RuntimeExecutor(new ProviderRouter(registry));
  }

  it("lists models from the selected provider", async () => {
    const executor = createExecutor([
      createStubProvider("stub", {
        listModels: () => Promise.resolve([{ id: "m1" }, { id: "m2" }]),
      }),
    ]);

    await expect(executor.listModels("stub")).resolves.toEqual([
      { id: "m1" },
      { id: "m2" },
    ]);
  });

  it("rejects listModels when provider id is missing", async () => {
    const executor = createExecutor([]);

    await expect(executor.listModels("missing")).rejects.toThrow(ProviderNotFoundError);
  });

  it("wraps listModels provider failures", async () => {
    const executor = createExecutor([
      createStubProvider("stub", {
        listModels: () => Promise.reject(new Error("models unavailable")),
      }),
    ]);

    await expect(executor.listModels("stub")).rejects.toMatchObject({
      name: "ProviderExecutionError",
      providerId: "stub",
      code: "PROVIDER_EXECUTION_ERROR",
      message: "models unavailable",
    });
  });

  it("executes through the resolved provider without knowing its implementation", async () => {
    const executor = createExecutor([createStubProvider("stub")]);

    const run = await executor.execute("stub", baseInput);
    const result = await run.wait();

    expect(result.status).toBe("completed");
    expect(result.output?.text).toBe("hello");
  });

  it("consumes provider event stream", async () => {
    const executor = createExecutor([createStubProvider("stub")]);
    const run = await executor.execute("stub", baseInput);

    const eventTypes: string[] = [];
    for await (const event of run.events) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual(["run.started", "message.delta", "run.completed"]);
  });

  it("throws ProviderNotFoundError when provider id is missing", async () => {
    const executor = createExecutor([]);

    await expect(executor.execute("missing", baseInput)).rejects.toThrow(
      ProviderNotFoundError,
    );
  });

  it("wraps provider execute failures in ProviderExecutionError", async () => {
    const rootCause = new Error("provider boom");
    const executor = createExecutor([
      createStubProvider("broken", {
        execute: () => Promise.reject(rootCause),
      }),
    ]);

    await expect(executor.execute("broken", baseInput)).rejects.toSatisfy(
      (error: unknown) => {
        if (!(error instanceof ProviderExecutionError)) {
          return false;
        }
        expect(error.providerId).toBe("broken");
        expect(error.message).toBe("provider boom");
        expect(error.cause).toBe(rootCause);
        return true;
      },
    );
  });

  it("selects providers independently by id", async () => {
    const executor = createExecutor([
      createStubProvider("a", {
        execute: (input) =>
          Promise.resolve(createCompletedRun("a", input.sessionId, "from-a")),
      }),
      createStubProvider("b", {
        execute: (input) =>
          Promise.resolve(createCompletedRun("b", input.sessionId, "from-b")),
      }),
    ]);

    const runA = await executor.execute("a", baseInput);
    const runB = await executor.execute("b", baseInput);

    expect((await runA.wait()).output?.text).toBe("from-a");
    expect((await runB.wait()).output?.text).toBe("from-b");
  });
});
