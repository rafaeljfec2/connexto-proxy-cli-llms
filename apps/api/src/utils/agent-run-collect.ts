import type { AgentEvent, AgentExecutionUsage, AgentRun } from "@agent-runtime-gateway/core";
import type { OpenAiToolCall } from "@agent-runtime-gateway/compatibility-openai";

export interface AgentRunOutput {
  text: string;
  toolCalls: OpenAiToolCall[];
  sawFailure: boolean;
  usage?: AgentExecutionUsage;
}

export function openAiToolCallFromAgentEvent(
  event: Extract<AgentEvent, { type: "tool.call" }>,
): OpenAiToolCall {
  return {
    id: event.callId,
    type: "function",
    function: {
      name: event.toolName,
      arguments: event.arguments ?? "{}",
    },
  };
}

export async function drainAgentRunEvents(
  run: AgentRun,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
  } = {},
): Promise<AgentRunOutput> {
  let text = "";
  const toolCalls: OpenAiToolCall[] = [];
  let sawFailure = false;

  for await (const event of run.events) {
    if (options.signal?.aborted) break;
    options.onEvent?.(event);
    if (event.type === "message.delta" && event.delta) {
      text += event.delta;
    } else if (event.type === "tool.call") {
      toolCalls.push(openAiToolCallFromAgentEvent(event));
    } else if (event.type === "run.failed") {
      sawFailure = true;
    }
  }

  return { text, toolCalls, sawFailure };
}
