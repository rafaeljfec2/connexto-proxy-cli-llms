import type {
  AgentEvent,
  AgentExecutionInput,
  AgentRun,
} from "@agent-runtime-gateway/core";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  app,
  disconnectStreamAfterDelta,
  hasOriginalProvider,
  installProvider,
  restoreProvider,
  startPendingChatRequest,
  startServer,
  stopServer,
} from "./helpers/stream-cancellation-fixture.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";

describe("HTTP stream cancellation", () => {
  beforeAll(async () => {
    if (!hasOriginalProvider()) throw new Error("Cursor provider is not registered");
    await startServer();
  });

  afterEach(restoreProvider);
  afterAll(stopServer);

  it("passes a unique signal to every provider-backed HTTP route", async () => {
    const inputs: AgentExecutionInput[] = [];
    installProvider(
      createStubProvider("cursor", {
        execute: (input) => {
          inputs.push(input);
          return Promise.resolve(
            createCompletedRun("cursor", input.sessionId, "mock response"),
          );
        },
      }),
    );

    const responses = await Promise.all([
      supertest(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ messages: [{ role: "user", content: "hello" }] }),
      supertest(app)
        .post("/v1/completions")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ prompt: "hello" }),
      supertest(app)
        .post("/v1/responses")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ input: "hello" }),
      supertest(app)
        .post("/v1/responses/compact")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ input: "hello" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const signals = inputs.flatMap((input) => (input.signal ? [input.signal] : []));
    expect(signals).toHaveLength(4);
    expect(new Set(signals).size).toBe(4);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("aborts the matching execution and stops forwarding after an SSE disconnect", async () => {
    let resolveEventsFinished: () => void = () => undefined;
    const eventsFinished = new Promise<void>((resolve) => {
      resolveEventsFinished = resolve;
    });
    const cancel = vi.fn(() => undefined);
    const deltasAfterClose: string[] = [];
    let executionSignal: AbortSignal | undefined;
    const marker = "first-controlled-delta";

    installProvider(
      createStubProvider("cursor", {
        execute: (input) => {
          executionSignal = input.signal;
          input.signal?.addEventListener("abort", cancel, { once: true });
          async function* events(): AsyncGenerator<AgentEvent> {
            try {
              yield {
                type: "run.started",
                runId: "controlled-run",
                providerId: "cursor",
                sessionId: input.sessionId,
                model: input.model,
              };
              yield {
                type: "message.delta",
                runId: "controlled-run",
                delta: marker,
              };
              await Promise.race([
                new Promise<void>((resolve) => {
                  if (input.signal?.aborted) {
                    resolve();
                    return;
                  }
                  input.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                }),
                new Promise<void>((resolve) => setTimeout(resolve, 200)),
              ]);
              if (input.signal?.aborted) return;
              deltasAfterClose.push("second-controlled-delta");
              yield {
                type: "message.delta",
                runId: "controlled-run",
                delta: "second-controlled-delta",
              };
            } finally {
              resolveEventsFinished();
            }
          }
          const run: AgentRun = {
            id: "controlled-run",
            events: events(),
            wait: () =>
              Promise.resolve({
                status: "completed",
                output: { text: marker },
              }),
            cancel: () => Promise.resolve(undefined),
          };
          return Promise.resolve(run);
        },
      }),
    );

    let resolveClosed: () => void = () => undefined;
    const clientResponseClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const received = await disconnectStreamAfterDelta(
      "/v1/chat/completions",
      {
        model: "composer-2.5",
        messages: [{ role: "user", content: "stream cancellation test" }],
        stream: true,
      },
      marker,
      resolveClosed,
    );
    await clientResponseClosed;
    await eventsFinished;

    expect(received).toContain(marker);
    expect(executionSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(deltasAfterClose).toEqual([]);
  });

  it("does not start SSE after a disconnect while provider execution is pending", async () => {
    let resolveExecution: (run: AgentRun) => void = () => undefined;
    let receivedInput: AgentExecutionInput | undefined;
    let eventsStarted = false;
    installProvider(
      createStubProvider("cursor", {
        execute: (input) => {
          receivedInput = input;
          return new Promise<AgentRun>((resolve) => {
            resolveExecution = resolve;
          });
        },
      }),
    );

    const pendingRequest = startPendingChatRequest(true);
    await vi.waitFor(() => expect(receivedInput).toBeDefined());
    pendingRequest.request.destroy();
    await pendingRequest.socketClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const signal = receivedInput?.signal;
    async function* events(): AsyncGenerator<AgentEvent> {
      eventsStarted = true;
      await Promise.resolve();
      yield {
        type: "run.started",
        runId: "pending-run",
        providerId: "cursor",
        sessionId: receivedInput?.sessionId ?? "pending",
        model: "composer-2.5",
      };
    }
    resolveExecution({
      id: "pending-run",
      events: events(),
      wait: () => Promise.resolve({ status: "completed", output: { text: "done" } }),
      cancel: () => Promise.resolve(undefined),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(signal?.aborted).toBe(true);
    expect(eventsStarted).toBe(false);
  });
});
