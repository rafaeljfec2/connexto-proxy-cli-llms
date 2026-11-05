import { encodeSse } from "../sse.js";
import type { OpenAiToolCall } from "./types.js";
import { usageFromChars } from "./pricing.js";
import { responseObject } from "./formatters.js";

export function chatChunk(input: {
  id: string;
  created: number;
  model: string;
  delta?: string;
  role?: "assistant";
  toolCall?: { index: number; value: OpenAiToolCall };
  finish?: boolean;
  finishReason?: "stop" | "tool_calls";
}): Uint8Array {
  const delta = input.finish
    ? {}
    : {
        ...(input.role ? { role: input.role } : {}),
        ...(input.delta ? { content: input.delta } : {}),
        ...(input.toolCall
          ? {
              tool_calls: [
                {
                  index: input.toolCall.index,
                  id: input.toolCall.value.id,
                  type: input.toolCall.value.type,
                  function: input.toolCall.value.function,
                },
              ],
            }
          : {}),
      };
  const chunk = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: input.finish ? (input.finishReason ?? "stop") : null,
      },
    ],
  };
  return encodeSse(chunk);
}

export function doneChunk(): Uint8Array {
  return encodeSse("[DONE]");
}

export function chatUsageChunk(input: {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  completionChars: number;
}): Uint8Array {
  return encodeSse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [],
    usage: usageFromChars(input.model, input.promptChars, input.completionChars),
  });
}

export function responseCreatedEvents(input: {
  id: string;
  created: number;
  model: string;
  metadata?: Record<string, unknown>;
}): Uint8Array[] {
  const base = {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    model: input.model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
    ...input.metadata,
  };
  return [
    encodeSse({ type: "response.created", response: base }, "response.created"),
    encodeSse({ type: "response.in_progress", response: base }, "response.in_progress"),
  ];
}

export function responseTextStartEvents(input: {
  id: string;
  outputIndex: number;
}): Uint8Array[] {
  const item = {
    id: `msg_${input.id.slice(5)}`,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  return [
    encodeSse(
      { type: "response.output_item.added", output_index: input.outputIndex, item },
      "response.output_item.added",
    ),
    encodeSse(
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: input.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      "response.content_part.added",
    ),
  ];
}

export function responseDeltaEvent(input: {
  id: string;
  delta: string;
  outputIndex?: number;
}): Uint8Array {
  return encodeSse(
    {
      type: "response.output_text.delta",
      item_id: `msg_${input.id.slice(5)}`,
      output_index: input.outputIndex ?? 0,
      content_index: 0,
      delta: input.delta,
    },
    "response.output_text.delta",
  );
}

export function responseToolCallEvents(input: {
  id: string;
  toolCall: OpenAiToolCall;
  outputIndex: number;
}): Uint8Array[] {
  const item = {
    id: `fc_${input.id.slice(5)}_${input.outputIndex}`,
    type: "function_call",
    status: "in_progress",
    call_id: input.toolCall.id,
    name: input.toolCall.function.name,
    arguments: "",
  };
  const doneItem = {
    ...item,
    status: "completed",
    arguments: input.toolCall.function.arguments,
  };
  return [
    encodeSse(
      { type: "response.output_item.added", output_index: input.outputIndex, item },
      "response.output_item.added",
    ),
    encodeSse(
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: input.outputIndex,
        delta: input.toolCall.function.arguments,
      },
      "response.function_call_arguments.delta",
    ),
    encodeSse(
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: input.outputIndex,
        arguments: input.toolCall.function.arguments,
      },
      "response.function_call_arguments.done",
    ),
    encodeSse(
      {
        type: "response.output_item.done",
        output_index: input.outputIndex,
        item: doneItem,
      },
      "response.output_item.done",
    ),
  ];
}

export function responseDoneEvents(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  metadata?: Record<string, unknown>;
  textStarted?: boolean;
  textOutputIndex?: number;
}): Uint8Array[] {
  const itemId = `msg_${input.id.slice(5)}`;
  const part = { type: "output_text", text: input.text, annotations: [] };
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [part],
  };
  const textEvents =
    input.textStarted || !(input.toolCalls ?? []).length
      ? [
          encodeSse(
            {
              type: "response.output_text.done",
              item_id: itemId,
              output_index: input.textOutputIndex ?? 0,
              content_index: 0,
              text: input.text,
            },
            "response.output_text.done",
          ),
          encodeSse(
            {
              type: "response.content_part.done",
              item_id: itemId,
              output_index: input.textOutputIndex ?? 0,
              content_index: 0,
              part,
            },
            "response.content_part.done",
          ),
          encodeSse(
            {
              type: "response.output_item.done",
              output_index: input.textOutputIndex ?? 0,
              item,
            },
            "response.output_item.done",
          ),
        ]
      : [];
  return [
    ...textEvents,
    encodeSse(
      { type: "response.completed", response: responseObject(input) },
      "response.completed",
    ),
  ];
}
