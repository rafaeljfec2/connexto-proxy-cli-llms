import type { OpenAiToolSpec } from "../types.js";
import { KNOWN_SDK_CANONICAL_TOOLS } from "../constants.js";
import { isRecord } from "../common.js";
import {
  normalizeToolName,
  canonicalToolName,
  mcpTargetForClientToolName,
} from "../tools/specs.js";
import {
  firstStringArg,
  firstStringArgAllowEmpty,
  firstNumberArg,
  firstNumberNamedArg,
  firstBooleanArg,
  pathCandidates,
  fileContentCandidates,
  oldTextCandidates,
  newTextCandidates,
  shellCommandCandidates,
  shellWorkdirCandidates,
  timeoutCandidates,
  globPatternCandidates,
  globPathCandidates,
  operationPropertyCandidates,
  firstMatchingProperty,
} from "../tools/candidates.js";
import { toolParameterSchema } from "../tools/schema.js";
import { schemaLooksCompatible } from "../tools/compatibility.js";
import { toolPropertyPrefersSecondsTimeout } from "../tools/normalizers.js";
import { sdkToolCallMemory } from "../tools/resolution.js";
import { parseToolCallArguments } from "../tools/workspace.js";
import { compactRecord } from "./helpers.js";

export function rememberOpenCodeToolCalls(
  toolCalls: unknown[],
  output: Map<string, { name: string; args: Record<string, unknown> }>,
): void {
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || typeof toolCall.id !== "string") continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
    if (!fn || typeof fn.name !== "string") continue;
    output.set(toolCall.id, {
      name: fn.name,
      args: parseToolCallArguments(fn.arguments),
    });
  }
}

export function sdkToolResultFeedback(
  toolCallId: string,
  fallbackToolName: string,
  resultText: string,
  toolCallById: Map<string, { name: string; args: Record<string, unknown> }>,
  tools: OpenAiToolSpec[] = [],
): Record<string, unknown> {
  const original = toolCallById.get(toolCallId);
  const sdkMemory = sdkToolCallMemory.get(toolCallId);
  const name = original?.name ?? fallbackToolName ?? "unknown";
  const args = original?.args ?? {};
  const tool = toolSpecByName(tools, name);
  const sdkName =
    sdkMemory?.name ??
    sdkCanonicalFromToolCallId(toolCallId) ??
    sdkToolNameForOpenCodeTool(name, args, tool);
  const sdkArgs = sdkMemory?.args ?? openCodeArgsToSdkArgs(name, args, tool, sdkName);
  return {
    type: "tool_call",
    call_id: toolCallId ? toolCallId : "unknown",
    name: sdkName,
    status: "completed",
    args: sdkArgs,
    result: openCodeToolResultToSdkResult(
      sdkMemory?.name ?? name,
      sdkMemory?.args ?? args,
      resultText,
      sdkName,
    ),
  };
}

export function sdkCanonicalFromToolCallId(toolCallId: string): string | undefined {
  const match =
    /_(shell|write|read|edit|delete|grep|glob|ls|readlints|mcp|semsearch|todowrite)_\d+$/i.exec(
      toolCallId,
    );
  if (!match) return undefined;
  const canonical = match[1].toLowerCase();
  return KNOWN_SDK_CANONICAL_TOOLS.has(canonical) ? canonical : undefined;
}

export function toolSpecByName(
  tools: OpenAiToolSpec[],
  name: string,
): OpenAiToolSpec | undefined {
  const normalized = normalizeToolName(name);
  return tools.find((tool) => normalizeToolName(tool.name) === normalized);
}

export function sdkToolNameForOpenCodeTool(
  name: string,
  args: Record<string, unknown> = {},
  tool?: OpenAiToolSpec,
): string {
  const directCanonical = canonicalToolName(name);
  if (KNOWN_SDK_CANONICAL_TOOLS.has(directCanonical)) return directCanonical;
  if (explicitMcpTargetForClientToolName(name)) return "mcp";
  const inferred = inferSdkCanonicalFromClientTool(args, tool);
  if (inferred) return inferred;
  if (mcpTargetForClientToolName(name)) return "mcp";
  return name;
}

export function explicitMcpTargetForClientToolName(
  name: string,
): { provider: string; toolName: string } | undefined {
  const trimmed = name.trim();
  return trimmed.startsWith("mcp__") ? mcpTargetForClientToolName(trimmed) : undefined;
}

export function inferSdkCanonicalFromClientTool(
  args: Record<string, unknown>,
  tool?: OpenAiToolSpec,
): string | undefined {
  const operation = firstStringArg(args, ...operationPropertyCandidates());
  const normalizedOperation = normalizeToolName(operation ?? "");
  if (["write", "create", "overwrite"].includes(normalizedOperation)) return "write";
  if (["replace", "strreplace", "edit", "update"].includes(normalizedOperation))
    return "edit";
  if (["read", "view", "open"].includes(normalizedOperation)) return "read";
  if (["delete", "remove"].includes(normalizedOperation)) return "delete";
  if (
    tool &&
    schemaLooksCompatible("shell", tool) &&
    firstStringArg(args, ...shellCommandCandidates())
  )
    return "shell";
  if (
    tool &&
    schemaLooksCompatible("edit", tool) &&
    firstStringArgAllowEmpty(args, ...oldTextCandidates()) !== undefined &&
    firstStringArgAllowEmpty(args, ...newTextCandidates()) !== undefined
  )
    return "edit";
  if (
    tool &&
    schemaLooksCompatible("write", tool) &&
    firstStringArg(args, ...pathCandidates()) &&
    firstStringArgAllowEmpty(args, ...fileContentCandidates()) !== undefined
  )
    return "write";
  if (
    tool &&
    schemaLooksCompatible("glob", tool) &&
    firstStringArg(args, ...globPatternCandidates())
  )
    return "glob";
  if (
    tool &&
    schemaLooksCompatible("grep", tool) &&
    firstStringArg(
      args,
      "pattern",
      "query",
      "search",
      "regex",
      "searchPattern",
      "search_pattern",
    )
  )
    return "grep";
  if (
    tool &&
    schemaLooksCompatible("ls", tool) &&
    firstStringArg(args, ...pathCandidates(), "directory", "dir")
  )
    return "ls";
  return undefined;
}

export function openCodeArgsToSdkArgs(
  toolName: string,
  args: Record<string, unknown>,
  tool?: OpenAiToolSpec,
  sdkName?: string,
): Record<string, unknown> {
  const canonical =
    sdkName && KNOWN_SDK_CANONICAL_TOOLS.has(sdkName)
      ? sdkName
      : sdkToolNameForOpenCodeTool(toolName, args, tool);
  const mcpTarget =
    canonical === "mcp"
      ? mcpTargetForClientToolName(toolName, { includeMapped: true })
      : undefined;
  if (mcpTarget) {
    return {
      providerIdentifier: mcpTarget.provider,
      toolName: mcpTarget.toolName,
      args,
    };
  }
  if (canonical === "shell") {
    const timeout = firstNumberNamedArg(args, ...timeoutCandidates());
    return compactRecord({
      command: firstStringArg(args, ...shellCommandCandidates()),
      workingDirectory: firstStringArg(args, ...shellWorkdirCandidates()),
      timeout: sdkTimeoutArgument(timeout, tool),
    });
  }
  if (canonical === "write") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates()),
      fileText: firstStringArg(
        args,
        ...fileContentCandidates(),
        ...newTextCandidates(),
      ),
    });
  }
  if (canonical === "read") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      offset: firstNumberArg(args, "offset", "start", "startLine", "start_line"),
      limit: firstNumberArg(
        args,
        "limit",
        "maxLines",
        "max_lines",
        "lineCount",
        "line_count",
      ),
    });
  }
  if (canonical === "delete") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
    });
  }
  if (canonical === "ls") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      limit: firstNumberArg(args, "limit", "maxResults", "max_results"),
    });
  }
  if (canonical === "edit") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      oldString: firstStringArgAllowEmpty(args, ...oldTextCandidates()),
      newString: firstStringArgAllowEmpty(args, ...newTextCandidates()),
    });
  }
  if (canonical === "glob") {
    return compactRecord({
      targetDirectory: firstStringArg(args, ...globPathCandidates()),
      globPattern: firstStringArg(args, ...globPatternCandidates()),
    });
  }
  if (canonical === "grep") {
    return compactRecord({
      pattern: firstStringArg(args, "pattern", "query", "search", "regex"),
      path: firstStringArg(args, "path", "directory", "cwd"),
      glob: firstStringArg(args, "glob", "include"),
      caseInsensitive: firstBooleanArg(
        args,
        "caseInsensitive",
        "case_insensitive",
        "ignoreCase",
        "ignore_case",
      ),
      literal: firstBooleanArg(args, "literal", "fixedString", "fixed_string"),
      context: firstNumberArg(args, "context", "contextLines", "context_lines"),
      headLimit: firstNumberArg(
        args,
        "headLimit",
        "head_limit",
        "limit",
        "maxResults",
        "max_results",
      ),
    });
  }
  return args;
}

export function openCodeToolResultToSdkResult(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  sdkName?: string,
): Record<string, unknown> {
  const parsed = parseToolResultPayload(resultText);
  const canonical =
    sdkName && KNOWN_SDK_CANONICAL_TOOLS.has(sdkName)
      ? sdkName
      : sdkToolNameForOpenCodeTool(toolName, args);
  if (canonical === "mcp") {
    return sdkToolResult(
      parsed,
      resultText,
      isRecord(parsed) ? parsed : { text: resultText },
    );
  }
  if (canonical === "shell") {
    return sdkToolResult(parsed, resultText, {
      exitCode: numberFromParsed(parsed, ["exitCode", "exit_code", "code"]) ?? 0,
      signal: stringFromParsed(parsed, ["signal"]) ?? "",
      stdout: stringFromParsed(parsed, ["stdout", "output", "text"]) ?? resultText,
      stderr: stringFromParsed(parsed, ["stderr", "error"]) ?? "",
      executionTime:
        numberFromParsed(parsed, ["executionTime", "durationMs", "duration_ms"]) ?? 0,
    });
  }
  if (canonical === "read") {
    const content =
      stringFromParsed(parsed, ["content", "text", "output"]) ?? resultText;
    return sdkToolResult(parsed, resultText, {
      content,
      totalLines: lineCount(content),
      fileSize: content.length,
    });
  }
  if (canonical === "write") {
    const fileText =
      firstStringArg(args, ...fileContentCandidates(), ...newTextCandidates()) ?? "";
    return sdkToolResult(parsed, resultText, {
      path: firstStringArg(args, ...pathCandidates()) ?? "",
      linesCreated: lineCount(fileText),
      fileSize: fileText.length,
    });
  }
  if (canonical === "edit") {
    return sdkToolResult(parsed, resultText, {
      diffString:
        stringFromParsed(parsed, ["diff", "diffString", "output"]) ?? resultText,
    });
  }
  if (canonical === "glob") {
    const files =
      stringsFromParsed(parsed, ["files", "paths"]) ?? resultTextLines(resultText);
    return sdkToolResult(parsed, resultText, {
      files,
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated: false,
    });
  }
  return sdkToolResult(parsed, resultText, {
    text: resultText,
  });
}

export function parseToolResultPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[")))
    return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isErrorToolResult(parsed: unknown, text: string): boolean {
  if (isRecord(parsed)) {
    if (parsed.isError === true || parsed.error !== undefined) return true;
    const exitCode = numberFromParsed(parsed, ["exitCode", "exit_code", "code"]);
    if (exitCode !== undefined && exitCode !== 0) return true;
  }
  return /^\s*(error|failed|exception)\b/i.test(text);
}

export function sdkToolResult(
  parsed: unknown,
  resultText: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (isErrorToolResult(parsed, resultText)) {
    return {
      status: "error",
      error: { message: errorMessageFromToolResult(parsed, resultText) },
    };
  }
  return { status: "success", value };
}

export function errorMessageFromToolResult(parsed: unknown, text: string): string {
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof parsed.message === "string") return parsed.message;
  }
  return text ? text : "Tool failed";
}

export function sdkTimeoutArgument(
  argument: { key: string; value: number } | undefined,
  tool: OpenAiToolSpec | undefined,
): number | undefined {
  if (!argument) return undefined;
  const source = normalizeToolName(argument.key);
  if (["timeoutms", "timeoutmilliseconds", "milliseconds"].includes(source))
    return argument.value;
  if (["timeoutseconds", "seconds"].includes(source)) return argument.value * 1000;
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const target =
    firstMatchingProperty(
      timeoutCandidates(),
      schema.properties,
      normalizedProperties,
    ) ?? argument.key;
  return toolPropertyPrefersSecondsTimeout(tool, target)
    ? argument.value * 1000
    : argument.value;
}

export function stringFromParsed(value: unknown, keys: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export function numberFromParsed(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

export function stringsFromParsed(
  value: unknown,
  keys: string[],
): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string"))
      return candidate;
  }
  return undefined;
}

export function resultTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}
