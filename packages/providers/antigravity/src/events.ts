import type { AgentEvent, AgentResult } from "@agent-runtime-gateway/core";

export function createRunStartedEvent(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly model: string;
}): AgentEvent {
  return {
    type: "run.started",
    runId: input.runId,
    providerId: "antigravity",
    sessionId: input.sessionId,
    model: input.model,
  };
}

export function mapAcpUpdateToEvent(
  runId: string,
  kind: string,
  update: unknown,
): AgentEvent | undefined {
  if (kind !== "agent_message_chunk" || !isRecord(update)) {
    return undefined;
  }
  const content = update["content"];
  if (!isRecord(content) || typeof content["text"] !== "string") {
    return undefined;
  }
  const delta = content["text"];
  if (delta.length === 0) {
    return undefined;
  }
  return { type: "message.delta", runId, delta };
}

export function createCompletedResult(text: string): AgentResult {
  return { status: "completed", output: { text } };
}

export function createCancelledResult(): AgentResult {
  return { status: "cancelled" };
}

export function createFailedResult(): AgentResult {
  return {
    status: "failed",
    error: {
      message: "Antigravity ACP execution failed.",
      code: "antigravity_execution_error",
    },
  };
}

export function createTerminalEvent(result: AgentResult, runId: string): AgentEvent {
  if (result.status === "completed") {
    return { type: "run.completed", runId };
  }
  if (result.status === "cancelled") {
    return { type: "run.cancelled", runId };
  }
  return {
    type: "run.failed",
    runId,
    message: "Antigravity ACP execution failed.",
    code: "antigravity_execution_error",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
