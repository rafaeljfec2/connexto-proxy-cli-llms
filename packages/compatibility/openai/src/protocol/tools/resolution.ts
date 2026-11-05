import type { CursorToolCall } from "../../types.js";
import type {
  OpenAiToolSpec,
  OpenAiToolCall,
  ToolCallContext,
  SdkToolCallMemory,
} from "../types.js";
import { SDK_TOOL_CALL_MEMORY_LIMIT, KNOWN_SDK_CANONICAL_TOOLS } from "../constants.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import {
  firstArg,
  firstStringArgAllowEmpty,
  pathCandidates,
  shouldIncludeOptionalPath,
} from "./candidates.js";
import { toolNameAliases } from "./aliases.js";
import { resolveSpecificMCPTool } from "./mcp-wrapper.js";
import {
  schemaLooksCompatible,
  schemaCompatibilityScore,
  nameMatchedToolCanAccept,
} from "./compatibility.js";
import { canEmulateWithShell } from "./shell.js";
import { normalizeToolArguments } from "./normalizers.js";
import { toolArgumentsSatisfySchema } from "./schema.js";

export const sdkToolCallMemory = new Map<string, SdkToolCallMemory>();

export function rememberSdkToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  sdkToolCallMemory.set(id, { name: canonicalToolName(name), args: { ...args } });
  if (sdkToolCallMemory.size <= SDK_TOOL_CALL_MEMORY_LIMIT) return;
  const overflow = sdkToolCallMemory.size - SDK_TOOL_CALL_MEMORY_LIMIT;
  for (const key of Array.from(sdkToolCallMemory.keys()).slice(0, overflow)) {
    sdkToolCallMemory.delete(key);
  }
}

export function normalizeSdkToolCall(toolCall: CursorToolCall): CursorToolCall {
  const args = toolCall.arguments ?? {};
  if (canonicalToolName(toolCall.name) === "edit") {
    const streamContent = firstStringArgAllowEmpty(
      args,
      "streamContent",
      "stream_content",
    );
    const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
    if (streamContent !== undefined && shouldIncludeOptionalPath(path)) {
      const nextArgs: Record<string, unknown> = {
        ...args,
        path,
        fileText: streamContent,
      };
      delete nextArgs.streamContent;
      delete nextArgs.stream_content;
      return { name: "write", arguments: nextArgs };
    }
  }
  return toolCall;
}

export function isKnownSdkCanonical(value: string): boolean {
  return KNOWN_SDK_CANONICAL_TOOLS.has(value);
}

export function resolveToolSpec(
  emittedName: string,
  args: Record<string, unknown>,
  tools: OpenAiToolSpec[],
): OpenAiToolSpec | undefined {
  const exact = tools.find((tool) => tool.name === emittedName);
  if (exact && nameMatchedToolCanAccept(emittedName, exact)) return exact;
  const normalized = normalizeToolName(emittedName);
  const match = tools.find((tool) => normalizeToolName(tool.name) === normalized);
  if (match && nameMatchedToolCanAccept(emittedName, match)) return match;
  if (canonicalToolName(emittedName) === "mcp") {
    const specific = resolveSpecificMCPTool(args, tools);
    if (specific) return specific;
  }
  const candidates = toolNameAliases(normalized);
  const alias = tools.find(
    (tool) =>
      candidates.includes(normalizeToolName(tool.name)) &&
      schemaLooksCompatible(emittedName, tool),
  );
  if (alias) return alias;
  if (canonicalToolName(emittedName) === "ls") {
    const glob = tools.find((tool) => schemaLooksCompatible("glob", tool));
    if (glob) return glob;
  }
  const compatible = tools
    .map((tool) => ({ tool, score: schemaCompatibilityScore(emittedName, tool) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.tool;
  if (compatible) return compatible;
  if (canEmulateWithShell(emittedName)) {
    return tools.find((tool) => schemaLooksCompatible("shell", tool));
  }
  return undefined;
}

export function toOpenAiToolCalls(input: {
  toolCalls: CursorToolCall[];
  tools?: OpenAiToolSpec[];
  responseId: string;
  startIndex?: number;
  context?: ToolCallContext;
}): OpenAiToolCall[] {
  const tools = input.tools ?? [];
  return input.toolCalls.flatMap((toolCall, offset) => {
    const index = (input.startIndex ?? 0) + offset;
    const normalizedToolCall = normalizeSdkToolCall(toolCall);
    const tool = resolveToolSpec(
      normalizedToolCall.name,
      normalizedToolCall.arguments ?? {},
      tools,
    );
    if (!tool && tools.length > 0) return [];
    const name = tool?.name ?? normalizedToolCall.name;
    const sdkCanonical = canonicalToolName(normalizedToolCall.name);
    const toolArguments = normalizeToolArguments(
      normalizedToolCall.arguments ?? {},
      tool,
      normalizedToolCall.name,
      0,
      input.context,
    );
    if (tool && !toolArgumentsSatisfySchema(toolArguments, tool)) return [];
    const id = `call_${input.responseId.replace(/[^A-Za-z0-9]/g, "").slice(-18)}_${sdkCanonical}_${index}`;
    rememberSdkToolCall(
      id,
      normalizedToolCall.name,
      normalizedToolCall.arguments ?? {},
    );
    return [
      {
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(toolArguments),
        },
      },
    ];
  });
}

export function hasCompatibleTool(
  sdkToolName: string,
  tools: OpenAiToolSpec[],
): boolean {
  return tools.some((tool) => schemaLooksCompatible(sdkToolName, tool));
}

export function hasAnyCompatibleTool(
  sdkToolNames: string[],
  tools: OpenAiToolSpec[],
): boolean {
  return sdkToolNames.some((sdkToolName) => hasCompatibleTool(sdkToolName, tools));
}

export function hasWorkspaceMutationCapability(tools: OpenAiToolSpec[]): boolean {
  return hasAnyCompatibleTool(["write", "shell"], tools);
}

export { normalizeToolArguments } from "./normalizers.js";
