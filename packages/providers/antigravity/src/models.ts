import type { Model } from "@agent-runtime-gateway/core";

export const ANTIGRAVITY_MODEL_PREFIX = "antigravity:";

const AGENT_MODELS = [
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
] as const;

export const ANTIGRAVITY_MODELS: readonly Model[] = AGENT_MODELS.map((model) => ({
  id: `${ANTIGRAVITY_MODEL_PREFIX}${model.value}`,
  name: `Antigravity ${model.name}`,
}));

export function findAntigravityModel(modelId: string): Model | undefined {
  return ANTIGRAVITY_MODELS.find((model) => model.id === modelId);
}

export function acpModelId(modelId: string): string | undefined {
  if (!modelId.startsWith(ANTIGRAVITY_MODEL_PREFIX)) {
    return undefined;
  }
  const value = modelId.slice(ANTIGRAVITY_MODEL_PREFIX.length);
  return AGENT_MODELS.some((model) => model.value === value) ? value : undefined;
}
