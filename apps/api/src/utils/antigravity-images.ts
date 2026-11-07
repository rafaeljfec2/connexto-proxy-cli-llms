import type { CursorImage } from "@agent-runtime-gateway/compatibility-openai";
import type { AgentExecutionInput, AgentImageInput } from "@agent-runtime-gateway/core";
import { resolveAgentImages } from "@agent-runtime-gateway/provider-antigravity";
import type { ProviderExecutionTarget } from "./provider-target.js";

/**
 * Normalizes image descriptors for Antigravity executions at the route
 * boundary so validation failures surface as HTTP 400 instead of provider
 * execution errors. Cursor targets never receive images.
 */
export async function resolveExecutionImages(
  target: ProviderExecutionTarget,
  images: readonly CursorImage[] | undefined,
  signal?: AbortSignal,
): Promise<AgentExecutionInput["images"]> {
  if (target.providerId !== "antigravity") {
    return undefined;
  }
  const resolved = await resolveAgentImages(images ?? [], { signal });
  return resolved.length > 0 ? resolved : undefined;
}

export function executionImagesInput(images: readonly AgentImageInput[] | undefined): {
  images?: readonly AgentImageInput[];
} {
  return images ? { images } : {};
}
