import type {
  AgentEvent,
  AgentResult,
  AgentRunStatus,
} from "@agent-runtime-gateway/core";
import type { Run, RunResult, SDKMessage } from "@cursor/sdk";

export function mapRunResultToAgentResult(result: RunResult): AgentResult {
  const status = mapRunStatus(result.status);

  if (status === "completed") {
    return {
      status,
      output: {
        text: result.result ?? "",
      },
    };
  }

  if (status === "cancelled") {
    return { status };
  }

  return {
    status: "failed",
    error: {
      message: result.error?.message ?? "Cursor run failed",
      code: result.error?.code,
    },
  };
}

function mapRunStatus(status: RunResult["status"]): AgentRunStatus {
  if (status === "finished") {
    return "completed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

export function mapSdkMessageToEvents(
  message: SDKMessage,
  runId: string,
): AgentEvent[] {
  if (message.type === "assistant") {
    const events: AgentEvent[] = [];
    for (const block of message.message?.content ?? []) {
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        events.push({
          type: "message.delta",
          runId,
          delta: block.text,
        });
      }
    }
    return events;
  }

  if (message.type === "tool_call") {
    if (message.status === "running") {
      return [
        {
          type: "tool.call",
          runId,
          toolName: message.name,
          callId: message.call_id,
        },
      ];
    }

    if (message.status === "completed") {
      return [
        {
          type: "tool.result",
          runId,
          callId: message.call_id,
          output: stringifyToolOutput(message.result),
        },
      ];
    }
  }

  return [];
}

function stringifyToolOutput(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function createRunStartedEvent(input: {
  runId: string;
  providerId: string;
  sessionId: string;
  model: string;
}): AgentEvent {
  return {
    type: "run.started",
    runId: input.runId,
    providerId: input.providerId,
    sessionId: input.sessionId,
    model: input.model,
  };
}

export function createRunCompletedEvent(runId: string): AgentEvent {
  return { type: "run.completed", runId };
}

export function createRunFailedEvent(
  runId: string,
  message: string,
  code?: string,
): AgentEvent {
  return { type: "run.failed", runId, message, code };
}

export function createRunCancelledEvent(runId: string): AgentEvent {
  return { type: "run.cancelled", runId };
}

export type { Run };
