import type {
  AgentEvent,
  AgentExecutionUsage,
  AgentResult,
} from "@agent-runtime-gateway/core";

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
  if (!isRecord(update)) {
    return undefined;
  }

  // 1. Message text streaming chunk
  if (kind === "agent_message_chunk") {
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

  // 2. Reasoning thought streaming chunk
  if (kind === "agent_thought_chunk") {
    const content = update["content"];
    if (!isRecord(content) || typeof content["text"] !== "string") {
      return undefined;
    }
    const delta = content["text"];
    if (delta.length === 0) {
      return undefined;
    }
    return { type: "reasoning.delta", runId, delta };
  }

  return undefined;
}

export function createCompletedResult(
  output: {
    text: string;
    thoughtText?: string;
    toolCalls?: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }[];
  },
  usage?: AgentExecutionUsage,
): AgentResult {
  return {
    status: "completed",
    output,
    ...(usage !== undefined ? { usage } : {}),
  };
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
