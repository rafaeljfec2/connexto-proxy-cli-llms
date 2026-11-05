import type { CursorModelPricing, OpenAiToolCall } from "./types.js";
import { CURSOR_MODEL_PRICING } from "./constants.js";
import { estimateTokens } from "./common.js";

export function pricingForModel(model: string): CursorModelPricing | null {
  return CURSOR_MODEL_PRICING[model.trim().toLowerCase()] ?? null;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function costFromTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const inputUsd = roundUsd((inputTokens / 1_000_000) * pricing.input);
  const outputUsd = roundUsd((outputTokens / 1_000_000) * pricing.output);
  return {
    currency: "USD",
    estimated: true,
    input_usd: inputUsd,
    output_usd: outputUsd,
    total_usd: roundUsd(inputUsd + outputUsd),
    pricing: {
      input_per_million_tokens_usd: pricing.input,
      output_per_million_tokens_usd: pricing.output,
      source: pricing.source,
    },
  };
}

export function usageFromChars(
  model: string,
  promptChars: number,
  completionChars: number,
) {
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = estimateTokens(completionChars);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
    cost: costFromTokens(model, promptTokens, completionTokens),
  };
}

export function responseUsageFromChars(
  model: string,
  inputChars: number,
  outputChars: number,
) {
  const inputTokens = estimateTokens(inputChars);
  const outputTokens = estimateTokens(outputChars);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
    cost: costFromTokens(model, inputTokens, outputTokens),
  };
}

export function serializedToolCallLength(toolCalls: OpenAiToolCall[]): number {
  return toolCalls.reduce(
    (sum, toolCall) =>
      sum + toolCall.function.name.length + toolCall.function.arguments.length,
    0,
  );
}

export function completionCharsFromOutput(
  text: string,
  toolCalls: OpenAiToolCall[] = [],
): number {
  return text.length + serializedToolCallLength(toolCalls);
}
