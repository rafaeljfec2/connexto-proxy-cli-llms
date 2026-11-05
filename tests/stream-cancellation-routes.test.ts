import type { AgentEvent, AgentRun } from "@agent-runtime-gateway/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  disconnectStreamAfterDelta,
  hasOriginalProvider,
  installProvider,
  restoreProvider,
  startServer,
  stopServer,
} from "./helpers/stream-cancellation-fixture.js";
import { createStubProvider } from "../packages/core/tests/helpers/stub-provider.js";

const streamRoutes = [
  {
    path: "/v1/completions",
    body: { prompt: "legacy stream cancellation test", stream: true },
  },
  {
    path: "/v1/responses",
    body: { input: "Responses stream cancellation test", stream: true },
  },
];

describe("HTTP stream cancellation across routes", () => {
  beforeAll(async () => {
    if (!hasOriginalProvider()) throw new Error("Cursor provider is not registered");
    await startServer();
  });

  afterEach(restoreProvider);
  afterAll(stopServer);

  it("aborts Responses and legacy completion streams after a client disconnect", async () => {
    for (const [index, route] of streamRoutes.entries()) {
      const marker = `controlled-delta-${index}`;
      let resolveEventsFinished: () => void = () => undefined;
      const eventsFinished = new Promise<void>((resolve) => {
        resolveEventsFinished = resolve;
      });
      const cancel = vi.fn(() => undefined);
      const deltasAfterClose: string[] = [];
      let executionSignal: AbortSignal | undefined;

      installProvider(
        createStubProvider("cursor", {
          execute: (input) => {
            executionSignal = input.signal;
            input.signal?.addEventListener("abort", cancel, { once: true });
            async function* events(): AsyncGenerator<AgentEvent> {
              try {
                yield {
                  type: "run.started",
                  runId: `controlled-run-${index}`,
                  providerId: "cursor",
                  sessionId: input.sessionId,
                  model: input.model,
                };
                yield {
                  type: "message.delta",
                  runId: `controlled-run-${index}`,
                  delta: marker,
                };
                await new Promise<void>((resolve) => {
                  if (input.signal?.aborted) {
                    resolve();
                    return;
                  }
                  input.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                if (input.signal?.aborted) return;
                deltasAfterClose.push("unexpected-delta");
                yield {
                  type: "message.delta",
                  runId: `controlled-run-${index}`,
                  delta: "unexpected-delta",
                };
              } finally {
                resolveEventsFinished();
              }
            }
            const run: AgentRun = {
              id: `controlled-run-${index}`,
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
        route.path,
        { ...route.body, model: "composer-2.5" },
        marker,
        resolveClosed,
      );
      await clientResponseClosed;
      await eventsFinished;

      expect(received).toContain(marker);
      expect(executionSignal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(deltasAfterClose).toEqual([]);
    }
  });
});
