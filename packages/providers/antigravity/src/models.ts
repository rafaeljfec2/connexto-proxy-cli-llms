import type { Model } from "@agent-runtime-gateway/core";

export const ANTIGRAVITY_MODEL_PREFIX = "antigravity:";

export interface ModelCapabilities {
  readonly tools: { readonly supported: boolean };
  readonly reasoning: { readonly supported: boolean };
}

export interface AntigravityModel extends Model {
  readonly capabilities: ModelCapabilities;
}

const AGENT_MODELS = [
  {
    value: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    value: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    value: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
  },
  {
    value: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    capabilities: { tools: { supported: true }, reasoning: { supported: false } },
  },
] as const;

const ACP_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-opus-4-6-thinking": "claude-opus-5-5",
  "claude-sonnet-5-5": "claude-sonnet-5-5",
  "claude-opus-5-5": "claude-opus-5-5",
};

export const ANTIGRAVITY_MODELS: readonly AntigravityModel[] = AGENT_MODELS.map((model) => ({
  id: `${ANTIGRAVITY_MODEL_PREFIX}${model.value}`,
  name: `Antigravity ${model.name}`,
  capabilities: model.capabilities,
}));

export function findAntigravityModel(modelId: string): AntigravityModel | undefined {
  return ANTIGRAVITY_MODELS.find((model) => model.id === modelId);
}

export function acpModelId(modelId: string): string | undefined {
  if (!modelId.startsWith(ANTIGRAVITY_MODEL_PREFIX)) {
    return undefined;
  }
  const value = modelId.slice(ANTIGRAVITY_MODEL_PREFIX.length);
  if (ACP_MODEL_ALIASES[value]) {
    return ACP_MODEL_ALIASES[value];
  }
  return AGENT_MODELS.some((model) => model.value === value) ? value : undefined;
}
