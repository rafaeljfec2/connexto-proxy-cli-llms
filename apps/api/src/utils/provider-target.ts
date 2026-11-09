import {
  HttpError,
  resolveCursorModel,
} from "@agent-runtime-gateway/compatibility-openai";
import {
  ANTIGRAVITY_MODEL_PREFIX,
  findAntigravityModel,
} from "@agent-runtime-gateway/provider-antigravity";
import type { ProviderCredential } from "@agent-runtime-gateway/core";

export type ProviderExecutionTarget =
  | {
      readonly providerId: "cursor";
      readonly modelId: string;
      readonly credentialType: "api_key";
    }
  | {
      readonly providerId: "antigravity";
      readonly modelId: string;
      readonly credentialType: "local";
    };

export function resolveProviderTarget(model: unknown): ProviderExecutionTarget {
  if (typeof model === "string" && model.startsWith(ANTIGRAVITY_MODEL_PREFIX)) {
    const modelId = model.slice(ANTIGRAVITY_MODEL_PREFIX.length);
    if (findAntigravityModel(model) === undefined || modelId.length === 0) {
      throw new HttpError(
        `The model '${model}' does not exist`,
        404,
        "model_not_found",
      );
    }
    return { providerId: "antigravity", modelId: model, credentialType: "local" };
  }

  return {
    providerId: "cursor",
    modelId: resolveCursorModel(model).id,
    credentialType: "api_key",
  };
}

export function providerCredential(
  target: ProviderExecutionTarget,
  cursorApiKey?: string,
): ProviderCredential {
  if (target.credentialType === "local") {
    return { type: "local", value: "" };
  }
  if (cursorApiKey === undefined || cursorApiKey.length === 0) {
    throw new HttpError("Missing Cursor API key", 401, "unauthorized");
  }
  return { type: "api_key", value: cursorApiKey };
}

export function assertAntigravityToolsUnsupported(
  _target: ProviderExecutionTarget,
  _toolCount: number,
): void {
  // Function tools are now supported for Antigravity models.
}
