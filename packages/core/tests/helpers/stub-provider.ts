import type {
  AgentEvent,
  AgentExecutionInput,
  AgentProvider,
  AgentResult,
  AgentRun,
  Model,
} from "@agent-runtime-gateway/core";

export function createStubProvider(
  id: string,
  handlers: {
    listModels?: () => Promise<Model[]>;
    execute?: (input: AgentExecutionInput) => Promise<AgentRun>;
  } = {},
): AgentProvider {
  return {
    id,
    listModels:
      handlers.listModels ??
      (() => Promise.resolve([{ id: "stub-model", name: "Stub Model" }])),
    execute:
      handlers.execute ??
      ((input) =>
        Promise.resolve(createCompletedRun(id, input.sessionId, input.message))),
  };
}

export function createCompletedRun(
  providerId: string,
  sessionId: string,
  text: string,
): AgentRun {
  const runId = `run_${providerId}_${sessionId}`;

  async function* events(): AsyncGenerator<AgentEvent> {
    await Promise.resolve();
    yield {
      type: "run.started",
      runId,
      providerId,
      sessionId,
      model: "stub-model",
    };
    yield {
      type: "message.delta",
      runId,
      delta: text,
    };
    yield { type: "run.completed", runId };
  }

  const result: AgentResult = {
    status: "completed",
    output: { text },
  };

  return {
    id: runId,
    events: events(),
    wait: () => Promise.resolve(result),
    cancel: () => Promise.resolve(undefined),
  };
}
