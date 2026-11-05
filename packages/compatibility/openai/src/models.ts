import { estimateTokens } from "./protocol/common.js";
export interface ComposerModel {
  id: string;
  name: string;
  inputCost: number;
  outputCost: number;
  contextWindow?: number;
}

export const COMPOSER_MODELS: ComposerModel[] = [
  { id: "composer-2.5", name: "Composer 2.5", inputCost: 0.5, outputCost: 2.5 },
  {
    id: "composer-2.5-fast",
    name: "Composer 2.5 Fast",
    inputCost: 3.0,
    outputCost: 15.0,
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    inputCost: 2.0,
    outputCost: 6.0,
    contextWindow: 256_000,
  },
  {
    id: "grok-4.6-fast",
    name: "Grok 4.6 Fast",
    inputCost: 4.0,
    outputCost: 12.0,
    contextWindow: 256_000,
  },
  { id: "grok-4.5", name: "Grok 4.5", inputCost: 2.0, outputCost: 6.0 },
  { id: "grok-4.5-fast", name: "Grok 4.5 Fast", inputCost: 4.0, outputCost: 18.0 },
];

export function resolveCursorModel(model: unknown): { id: string } {
  if (typeof model !== "string" || !model.trim()) return { id: "composer-2.5" };
  const normalized = model.trim().toLowerCase();
  if (
    normalized === "composer-2.5" ||
    normalized === "composer-2-5" ||
    normalized === "composer-2.5-sdk" ||
    normalized === "composer-latest" ||
    normalized === "auto" ||
    normalized === "default"
  ) {
    return { id: "composer-2.5" };
  }
  if (normalized === "composer-2.5-fast" || normalized === "composer-2-5-fast") {
    return { id: "composer-2.5-fast" };
  }
  if (normalized === "grok-4.6" || normalized === "grok-4-6") {
    return { id: "grok-4.6" };
  }
  if (normalized === "grok-4.6-fast" || normalized === "grok-4-6-fast") {
    return { id: "grok-4.6-fast" };
  }
  if (normalized === "grok-4.5" || normalized === "grok-4-5") {
    return { id: "grok-4.5" };
  }
  if (normalized === "grok-4.5-fast" || normalized === "grok-4-5-fast") {
    return { id: "grok-4.5-fast" };
  }
  return { id: model.trim() };
}

export function findComposerModel(id: string): ComposerModel | undefined {
  const resolved = resolveCursorModel(id).id;
  return COMPOSER_MODELS.find((m) => m.id === resolved || m.id === id);
}

export function openAiModelObject(model: ComposerModel): Record<string, unknown> {
  return {
    id: model.id,
    object: "model",
    created: 1735689600,
    owned_by: "cursor",
    permission: [],
    root: model.id,
    parent: null,
  };
}

export function openAiModelList(): {
  object: string;
  data: Array<Record<string, unknown>>;
} {
  return {
    object: "list",
    data: COMPOSER_MODELS.map(openAiModelObject),
  };
}

export function textCompletionResponse(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  promptChars: number;
  cursorRunId?: string;
}): Record<string, unknown> {
  const promptTokens = estimateTokens(input.promptChars);
  const completionTokens = estimateTokens(input.text.length);
  return {
    id: input.id,
    object: "text_completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        text: input.text,
        index: 0,
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    cursor_run_id: input.cursorRunId ?? null,
  };
}
