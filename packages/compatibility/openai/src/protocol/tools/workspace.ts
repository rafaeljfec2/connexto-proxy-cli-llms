import type { OpenAiToolSpec } from "../types.js";
import { isRecord } from "../common.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import { explicitlyRequestedToolName } from "./hints.js";
import {
  firstArg,
  firstStringArg,
  firstStringArgAllowEmpty,
  pathCandidates,
  operationPropertyCandidates,
  shouldIncludeOptionalPath,
} from "./candidates.js";
import { schemaLooksCompatible } from "./compatibility.js";
import { wrapperObjectPropertyCandidates } from "./schema.js";
import {
  hasCompatibleTool,
  hasWorkspaceMutationCapability,
  resolveToolSpec,
} from "./resolution.js";
import { recordArgumentValue } from "./mcp-wrapper.js";

export function contentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

export function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function toolChoiceFunctionName(toolChoice: unknown): string | undefined {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") return undefined;
  if (typeof toolChoice.name === "string" && toolChoice.name.trim())
    return toolChoice.name.trim();
  if (
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string" &&
    toolChoice.function.name.trim()
  ) {
    return toolChoice.function.name.trim();
  }
  return undefined;
}

export function shouldRequireLocalTool(text: string, tools: OpenAiToolSpec[]): boolean {
  if (!tools.length) return false;
  if (explicitlyRequestedToolName(text, tools)) return true;
  const lower = text.toLowerCase();
  const hasPathSignal =
    lower.includes("~/") ||
    lower.includes("/") ||
    lower.includes("desktop") ||
    lower.includes("file") ||
    lower.includes("folder") ||
    lower.includes("directory") ||
    /\b[\w.-]+\.(html|css|js|ts|tsx|jsx|json|md|txt|py|rb|go|rs|swift|toml|ya?ml)\b/.test(
      lower,
    );
  const wantsFileMutation =
    /\b(create|write|save|overwrite|edit|modify|update|delete|remove|make)\b/.test(
      lower,
    );
  if (hasPathSignal && wantsFileMutation && hasWorkspaceMutationCapability(tools))
    return true;

  const wantsProjectScaffold =
    /\b(build|create|make|scaffold|generate|implement|setup|set up)\b/.test(lower) &&
    /\b(app|application|site|website|project|component|page|vite|react|next|vue|svelte|todo|dashboard|cli)\b/.test(
      lower,
    );
  if (wantsProjectScaffold && hasWorkspaceMutationCapability(tools)) return true;

  const wantsCommand =
    /\b(run|execute|start|launch)\b/.test(lower) &&
    (lower.includes("command") ||
      lower.includes("shell") ||
      lower.includes("terminal") ||
      lower.includes("server"));
  return wantsCommand && hasCompatibleTool("shell", tools);
}

export function hasRequiredLocalToolCall(
  messages: unknown[],
  tools: OpenAiToolSpec[],
  latestUserText: string,
): boolean {
  const requestedTool = explicitlyRequestedToolName(latestUserText, tools);
  if (requestedTool)
    return hasSpecificToolCallAfterLatestUser(messages, requestedTool, tools);
  return hasWorkspaceMutationToolCall(messages, tools);
}

export function hasRequiredResponseLocalToolCall(
  input: unknown,
  tools: OpenAiToolSpec[],
  latestUserText: string,
): boolean {
  const requestedTool = explicitlyRequestedToolName(latestUserText, tools);
  if (requestedTool)
    return hasSpecificResponseToolCallAfterLatestUser(input, requestedTool, tools);
  return hasResponseWorkspaceMutationToolCall(input, tools);
}

export function latestUserTextFromMessages(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "user") continue;
    return contentToPlainText(message.content);
  }
  return "";
}

export function latestUserTextFromResponseInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let i = input.length - 1; i >= 0; i--) {
    const item: unknown = input[i];
    if (typeof item === "string") return item;
    if (!isRecord(item)) continue;
    if (item.type === "message" || typeof item.role === "string") {
      const role = typeof item.role === "string" ? item.role : "user";
      if (role === "user") return contentToPlainText(item.content);
    }
  }
  return "";
}

export function hasWorkspaceMutationToolCall(
  messages: unknown[],
  tools: OpenAiToolSpec[] = [],
): boolean {
  let sawLatestUser = false;
  let mutationAfterLatestUser = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "user" && contentToPlainText(message.content).trim()) {
      sawLatestUser = true;
      mutationAfterLatestUser = false;
    }
    if (
      sawLatestUser &&
      typeof message.name === "string" &&
      isWorkspaceMutationToolCall(message.name, undefined, tools)
    ) {
      mutationAfterLatestUser = true;
    }
    if (!Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      if (
        sawLatestUser &&
        typeof fn?.name === "string" &&
        isWorkspaceMutationToolCall(fn.name, fn.arguments, tools)
      ) {
        mutationAfterLatestUser = true;
      }
    }
  }
  return mutationAfterLatestUser;
}

export function hasSpecificToolCallAfterLatestUser(
  messages: unknown[],
  requestedTool: string,
  tools: OpenAiToolSpec[] = [],
): boolean {
  let sawLatestUser = false;
  let foundAfterLatestUser = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "user" && contentToPlainText(message.content).trim()) {
      sawLatestUser = true;
      foundAfterLatestUser = false;
    }
    if (!sawLatestUser || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
      if (!fn || typeof fn.name !== "string") continue;
      if (
        toolCallMatchesClientTool(
          fn.name,
          parseToolCallArguments(fn.arguments),
          requestedTool,
          tools,
        )
      ) {
        foundAfterLatestUser = true;
      }
    }
  }
  return foundAfterLatestUser;
}

export function hasResponseWorkspaceMutationToolCall(
  input: unknown,
  tools: OpenAiToolSpec[] = [],
): boolean {
  if (!Array.isArray(input)) return false;
  let sawLatestUser = false;
  let mutationAfterLatestUser = false;
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      sawLatestUser = true;
      mutationAfterLatestUser = false;
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === "message" || typeof item.role === "string") {
      const role = typeof item.role === "string" ? item.role : "user";
      if (role === "user" && contentToPlainText(item.content).trim()) {
        sawLatestUser = true;
        mutationAfterLatestUser = false;
      }
      continue;
    }
    if (
      !sawLatestUser ||
      item.type !== "function_call" ||
      typeof item.name !== "string"
    )
      continue;
    if (isWorkspaceMutationToolCall(item.name, item.arguments, tools))
      mutationAfterLatestUser = true;
  }
  return mutationAfterLatestUser;
}

export function hasSpecificResponseToolCallAfterLatestUser(
  input: unknown,
  requestedTool: string,
  tools: OpenAiToolSpec[] = [],
): boolean {
  if (!Array.isArray(input)) return false;
  let sawLatestUser = false;
  let foundAfterLatestUser = false;
  for (const item of input) {
    if (typeof item === "string") {
      if (item.trim()) {
        sawLatestUser = true;
        foundAfterLatestUser = false;
      }
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === "message" || typeof item.role === "string") {
      const role = typeof item.role === "string" ? item.role : "user";
      if (role === "user" && contentToPlainText(item.content).trim()) {
        sawLatestUser = true;
        foundAfterLatestUser = false;
      }
      continue;
    }
    if (
      !sawLatestUser ||
      item.type !== "function_call" ||
      typeof item.name !== "string"
    )
      continue;
    if (
      toolCallMatchesClientTool(
        item.name,
        parseToolCallArguments(item.arguments),
        requestedTool,
        tools,
      )
    ) {
      foundAfterLatestUser = true;
    }
  }
  return foundAfterLatestUser;
}

export function toolCallMatchesClientTool(
  name: string,
  args: Record<string, unknown>,
  requestedTool: string,
  tools: OpenAiToolSpec[],
): boolean {
  if (normalizeToolName(name) === normalizeToolName(requestedTool)) return true;
  const resolved = tools.length ? resolveToolSpec(name, args, tools) : undefined;
  return normalizeToolName(resolved?.name ?? "") === normalizeToolName(requestedTool);
}

export function isWorkspaceMutationToolCall(
  name: string,
  args: unknown,
  tools: OpenAiToolSpec[] = [],
): boolean {
  const parsed = parseToolCallArguments(args);
  const canonical = canonicalToolName(name);
  if (["write", "edit", "delete"].includes(canonical)) return true;
  if (canonical === "shell") {
    const command = firstStringArgFromRecords(parsed, [
      "command",
      "cmd",
      "script",
      "input",
    ]);
    return command ? isFileMutatingShellCommand(command) : false;
  }

  const tool = tools.length ? resolveToolSpec(name, parsed, tools) : undefined;
  if (!tool) return false;
  if (schemaLooksCompatible("shell", tool)) {
    const command = firstStringArgFromRecords(parsed, [
      "command",
      "cmd",
      "script",
      "input",
    ]);
    if (command && isFileMutatingShellCommand(command)) return true;
  }
  if (
    (schemaLooksCompatible("write", tool) ||
      schemaLooksCompatible("edit", tool) ||
      schemaLooksCompatible("delete", tool)) &&
    looksLikeWorkspaceMutationArguments(parsed)
  ) {
    return true;
  }
  return false;
}

export function argumentRecords(
  args: Record<string, unknown>,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 3 || Array.isArray(args)) return [args];
  const records = [args];
  for (const key of wrapperObjectPropertyCandidates()) {
    const nested = recordArgumentValue(args[key]);
    if (!nested || Array.isArray(nested)) continue;
    records.push(...argumentRecords(nested, depth + 1));
  }
  return records;
}

export function firstStringArgFromRecords(
  args: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const record of argumentRecords(args)) {
    const value = firstStringArg(record, ...keys);
    if (value) return value;
  }
  return undefined;
}

export function looksLikeWorkspaceMutationArguments(
  args: Record<string, unknown>,
): boolean {
  for (const record of argumentRecords(args)) {
    const path = firstArg(record, [...pathCandidates(), "target_file", "targetFile"]);
    const hasPath = path !== undefined && shouldIncludeOptionalPath(path);
    const patch = firstStringArgAllowEmpty(
      record,
      "patchContent",
      "patch_content",
      "patch",
      "diff",
      "unifiedDiff",
      "unified_diff",
    );
    if (patch !== undefined) return true;

    const operation = firstStringArg(record, ...operationPropertyCandidates());
    const normalizedOperation = operation ? normalizeToolName(operation) : "";
    const mutatingOperation = [
      "write",
      "create",
      "overwrite",
      "replace",
      "edit",
      "update",
      "delete",
      "remove",
      "strreplace",
    ].includes(normalizedOperation);
    if (!hasPath) continue;

    const content = firstStringArgAllowEmpty(
      record,
      "fileText",
      "file_text",
      "content",
      "contents",
      "text",
      "fileContent",
      "file_content",
      "streamContent",
      "stream_content",
    );
    const oldText = firstStringArgAllowEmpty(
      record,
      "oldString",
      "old_string",
      "old_str",
      "oldText",
      "old_text",
      "search",
      "searchString",
      "search_string",
    );
    const newText = firstStringArgAllowEmpty(
      record,
      "newString",
      "new_string",
      "new_str",
      "newText",
      "new_text",
      "replacement",
      "replace",
    );

    if (content !== undefined && (!operation || mutatingOperation)) return true;
    if (
      oldText !== undefined &&
      newText !== undefined &&
      (!operation || mutatingOperation)
    )
      return true;
    if (["delete", "remove"].includes(normalizedOperation)) return true;
  }
  return false;
}

export function isFileMutatingShellCommand(command: string): boolean {
  const text = command.toLowerCase();
  if (/(^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:>|>>|<<)/.test(text)) return true;
  if (/(?:^|[\s;&|])(?:tee|touch|cp|mv|rm)\b/.test(text)) return true;
  if (/(?:^|[\s;&|])sed\b[^\n]*(?:\s-i\b|\s-i['"]?\s)/.test(text)) return true;
  if (/(?:^|[\s;&|])perl\b[^\n]*(?:\s-pi\b|\s-pi['"]?\s)/.test(text)) return true;
  if (/(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:init|install|add|create)\b/.test(text))
    return true;
  return /(?:>|>>)\s*(?:\.{0,2}\/)?[a-z0-9._/-]+/.test(text);
}

export function addWorkspaceActionToUserText(text: string): string {
  const userText = text ? text : "[empty]";
  return [
    userText,
    "",
    "Workspace action required: create or update the necessary project files directly with write/edit/bash tools. Do not output code for the user to save.",
  ].join("\n");
}
