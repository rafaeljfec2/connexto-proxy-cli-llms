import type {
  AgentEvent,
  AgentResult,
  AgentRun,
} from "@agent-runtime-gateway/core";
import type { CursorToolCall } from "@agent-runtime-gateway/compatibility-openai";
import type { CursorTextEvent } from "./engine/types.js";
import {
  createRunCancelledEvent,
  createRunCompletedEvent,
  createRunFailedEvent,
  createRunStartedEvent,
} from "./events.js";

function toolCallId(toolCall: CursorToolCall): string {
  const rawName = toolCall.name?.trim();
  if (rawName) return `call_${rawName}`;
  return "tool_call";
}

export function agentRunFromCursorTextStream(input: {
  providerId: string;
  sessionId: string;
  model: string;
  runId: string;
  stream: AsyncIterable<CursorTextEvent>;
  signal?: AbortSignal;
}): AgentRun {
  let finalText = "";
  let settledResult: AgentResult | undefined;
  const waiters: Array<(result: AgentResult) => void> = [];
  let toolCallSeq = 0;
  let abortListener: (() => void) | undefined;

  const removeAbortListener = (): void => {
    if (input.signal !== undefined && abortListener !== undefined) {
      input.signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  const settle = (result: AgentResult): void => {
    if (settledResult !== undefined) return;
    settledResult = result;
    removeAbortListener();
    for (const resolve of waiters) resolve(result);
    waiters.length = 0;
  };

  async function* events(): AsyncGenerator<AgentEvent> {
    yield createRunStartedEvent({
      runId: input.runId,
      providerId: input.providerId,
      sessionId: input.sessionId,
      model: input.model,
    });

    try {
      for await (const event of input.stream) {
        if (input.signal?.aborted) break;
        if (event.type === "text" && event.text.length > 0) {
          finalText += event.text;
          yield {
            type: "message.delta",
            runId: input.runId,
            delta: event.text,
          };
        } else if (event.type === "tool_call") {
          toolCallSeq += 1;
          yield {
            type: "tool.call",
            runId: input.runId,
            toolName: event.toolCall.name,
            callId: `${toolCallId(event.toolCall)}_${toolCallSeq}`,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
          };
        } else if (event.type === "rejected_tool_call") {
          const message =
            event.reason ??
            `Rejected client tool call: ${event.toolCall.name ?? "unknown"}`;
          yield createRunFailedEvent(input.runId, message, "cursor_tool_call_rejected");
          settle({
            status: "failed",
            error: { message, code: "cursor_tool_call_rejected" },
          });
          return;
        } else if (event.type === "done") {
          finalText = event.finalText.length > 0 ? event.finalText : finalText;
        }
      }

      if (input.signal?.aborted) {
        yield createRunCancelledEvent(input.runId);
        settle({ status: "cancelled" });
        return;
      }

      yield createRunCompletedEvent(input.runId);
      settle({
        status: "completed",
        output: { text: finalText },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cursor edge run failed";
      yield createRunFailedEvent(input.runId, message);
      settle({
        status: "failed",
        error: { message },
      });
    }
  }

  const wait = async (): Promise<AgentResult> => {
    if (settledResult !== undefined) return settledResult;
    return new Promise<AgentResult>((resolve) => {
      waiters.push(resolve);
    });
  };

  const cancel = (): Promise<void> => {
    if (settledResult !== undefined) return Promise.resolve();
    settle({ status: "cancelled" });
    return Promise.resolve();
  };

  if (input.signal !== undefined) {
    abortListener = () => {
      void cancel();
    };
    if (input.signal.aborted) void cancel();
    else input.signal.addEventListener("abort", abortListener, { once: true });
  }

  return {
    id: input.runId,
    events: events(),
    wait,
    cancel,
  };
}
