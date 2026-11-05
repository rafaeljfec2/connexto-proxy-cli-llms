import type {
  CursorImage,
  CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import { SDK_TOOL_RETRY_ATTEMPTS } from "./types.js";

export function sdkPrompt(prompt: { text: string; images?: CursorImage[] }): string {
  if (!prompt.images?.length) return prompt.text;
  return `${prompt.text}\n\n[${prompt.images.length} image input${prompt.images.length === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
}

export function retryPromptAfterMissingTool(
  prompt: string,
  attempt = 2,
  maxAttempts = SDK_TOOL_RETRY_ATTEMPTS,
): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    "Your previous SDK response did not emit a local tool call, but the latest user request requires local OpenCode execution.",
    "The next response is invalid unless it contains a tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call now using the allowed OpenCode tool inventory above, then wait for the local tool result.",
    "Use SDK mcp for an exact client tool route, or SDK shell/write when the routing map says those built-ins map to the client schema.",
    "If a specific client tool was named in the request, use that exact tool mapping and do not substitute shell, glob, or prose.",
  ].join("\n");
}

export function retryPromptAfterUnsupportedTool(
  prompt: string,
  toolCall: CursorToolCall,
  reason?: string,
  attempt = 2,
  maxAttempts = SDK_TOOL_RETRY_ATTEMPTS,
): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    `Your previous SDK response requested ${toolCall.name}, but that tool could not be mapped to the allowed OpenCode tool inventory above.`,
    ...(reason ? [`Mapping failure detail: ${reason}`] : []),
    "The next response is invalid unless it contains a mappable tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call that maps to an allowed client tool.",
    "For filesystem mutations, prefer SDK write with path and fileText or SDK shell with command when those capabilities are present.",
    "For OpenCode MCP/server tools exposed as provider_tool names, use SDK mcp with providerIdentifier, toolName, and args.",
  ].join("\n");
}
