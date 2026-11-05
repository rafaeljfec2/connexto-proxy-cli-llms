import type { OpenAiToolCall, OpenAiToolSpec } from "./types.js";
import { isRecord } from "./common.js";
import {
  completionCharsFromOutput,
  pricingForModel,
  responseUsageFromChars,
  usageFromChars,
} from "./pricing.js";

export function chatCompletionResponse(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const toolCalls = input.toolCalls ?? [];
  const completionChars = completionCharsFromOutput(input.text, toolCalls);
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !input.text ? null : input.text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          refusal: null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: usageFromChars(input.model, input.promptChars, completionChars),
    service_tier: "default",
    system_fingerprint: null,
    ...input.metadata,
  };
}

export function responseObject(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const messageId = `msg_${input.id.slice(5)}`;
  const output: Record<string, unknown>[] = [];
  if (input.text || !input.toolCalls?.length) {
    output.push({
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: input.text,
          annotations: [],
        },
      ],
    });
  }
  for (const [index, toolCall] of (input.toolCalls ?? []).entries()) {
    output.push({
      id: `fc_${input.id.slice(5)}_${index}`,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }
  const outputChars = completionCharsFromOutput(input.text, input.toolCalls ?? []);
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "completed",
    completed_at: Math.max(input.created, Math.floor(Date.now() / 1000)),
    error: null,
    incomplete_details: null,
    model: input.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: responseUsageFromChars(input.model, input.promptChars, outputChars),
    user: null,
    metadata: {},
    ...input.metadata,
  };
}

export function responseInputItemsObject(
  inputItems: unknown[] = [],
): Record<string, unknown> {
  const data = inputItems.map((item, index) => normalizeResponseInputItem(item, index));
  return {
    object: "list",
    data,
    first_id: responseInputItemId(data[0]) ?? null,
    last_id: responseInputItemId(data[data.length - 1]) ?? null,
    has_more: false,
  };
}

export function responseToolMetadata(
  tools: OpenAiToolSpec[],
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
  }));
}

export function responseToolChoiceMetadata(toolChoice: unknown): unknown {
  return toolChoice === undefined ? "auto" : toolChoice;
}

export function normalizeResponseInputItem(item: unknown, index: number): unknown {
  if (isRecord(item)) {
    return item.id === undefined ? { ...item, id: `item_${index}` } : item;
  }
  return responseInputMessage(responseInputText(item), `item_${index}`);
}

export function responseInputMessage(
  text: string,
  id: string,
): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

export function responseInputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

export function responseInputItemId(item: unknown): string | undefined {
  return isRecord(item) && typeof item.id === "string" ? item.id : undefined;
}

export function modelItem(id: string, name: string): Record<string, unknown> {
  const pricing = pricingForModel(id);
  return {
    id,
    object: "model",
    created: 1779148800,
    owned_by: "cursor",
    name,
    ...(pricing ? { cost: { input: pricing.input, output: pricing.output } } : {}),
  };
}

export function modelList(
  options: { opencode?: boolean; sdk?: boolean } = {},
): Record<string, unknown> {
  return {
    object: "list",
    data: [
      modelItem("default", "Auto"),
      modelItem(
        "composer-2.5",
        options.opencode ? "Composer 2.5" : "Cursor Composer 2.5",
      ),
      ...(options.sdk
        ? [modelItem("composer-2.5-sdk", "Composer 2.5 SDK Harness")]
        : []),
      modelItem("composer-2.5-fast", "Cursor Composer 2.5 Fast"),
      modelItem("composer-2", "Cursor Composer 2"),
      modelItem("composer-latest", "Cursor Composer latest alias"),
      modelItem("gpt-5.3-codex", "Codex 5.3"),
      modelItem("gpt-5.2-codex", "Codex 5.2"),
      modelItem("gpt-5.1-codex-max", "Codex 5.1 Max"),
      modelItem("gpt-5.1-codex-mini", "Codex 5.1 Mini"),
      modelItem("gpt-5.2", "GPT-5.2"),
      modelItem("gpt-5.1", "GPT-5.1"),
      modelItem("gpt-5-mini", "GPT-5 Mini"),
      modelItem("gemini-3.1-pro", "Gemini 3.1 Pro"),
      modelItem("gemini-3.5-flash", "Gemini 3.5 Flash"),
      modelItem("gemini-3-flash", "Gemini 3 Flash"),
      modelItem("gemini-2.5-flash", "Gemini 2.5 Flash"),
      modelItem("grok-build-0.1", "Grok Build 0.1"),
      modelItem("grok-4.3", "Grok 4.3"),
      modelItem("grok-4.6", "Grok 4.6"),
      modelItem("grok-4.6-fast", "Grok 4.6 Fast"),
      modelItem("grok-4.5", "Grok 4.5"),
      modelItem("grok-4.5-fast", "Grok 4.5 Fast"),
      modelItem("kimi-k2.5", "Kimi K2.5"),
    ],
  };
}
