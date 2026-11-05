import {
  HttpError,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import type { LocalSdkDecodedEvent } from "./types.js";
import {
  EXEC_TOOL_SPECS,
  TOOL_CALL_SPECS,
  decodeToolArgs,
  hasAnyStringArg,
  hasAnyStringArgAllowEmpty,
  hasGlobRequest,
  stringArg,
  stringArgAllowEmpty,
} from "./tool-specs.js";
import { decodeProtobufFields } from "../engine/connect-proto.js";
import { bytesField, numberField, stringField } from "./proto.js";

export function isEmittableSdkToolCall(toolCall: CursorToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") return hasGlobRequest(args);
  if (name === "ls") return true;
  if (name === "shell") return hasAnyStringArg(args, "command", "cmd", "script");
  if (name === "write") {
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file",
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "fileText",
        "file_text",
        "content",
        "contents",
        "text",
        "fileContent",
        "file_content",
        "streamContent",
        "stream_content",
      )
    );
  }
  if (name === "edit") {
    const hasCompleteReplacement =
      hasAnyStringArgAllowEmpty(
        args,
        "oldText",
        "old_text",
        "oldString",
        "old_string",
        "old_str",
        "old",
        "search",
        "searchString",
        "search_string",
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "newText",
        "new_text",
        "newString",
        "new_string",
        "new_str",
        "replacement",
        "replace",
        "content",
      );
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file",
      ) &&
      (hasAnyStringArgAllowEmpty(
        args,
        "patchContent",
        "patch_content",
        "patch",
        "diff",
        "unifiedDiff",
        "unified_diff",
      ) ||
        hasAnyStringArgAllowEmpty(args, "streamContent", "stream_content") ||
        hasCompleteReplacement)
    );
  }
  if (name === "read" || name === "delete")
    return hasAnyStringArg(
      args,
      "path",
      "filePath",
      "file_path",
      "targetFile",
      "target_file",
    );
  if (name === "grep")
    return hasAnyStringArg(args, "pattern", "query", "regex", "search");
  if (name === "semSearch") return hasAnyStringArg(args, "query", "pattern", "search");
  if (name === "readLints")
    return (
      Array.isArray(args.paths) &&
      args.paths.some((item) => typeof item === "string" && item.trim())
    );
  if (name === "mcp") return hasAnyStringArg(args, "toolName", "tool_name", "name");
  return Object.keys(args).length > 0;
}

export function normalizeSdkToolCallForOpenCode(
  toolCall: CursorToolCall,
): CursorToolCall {
  if (toolCall.name.toLowerCase() !== "edit") return toolCall;
  const path = stringArg(toolCall.arguments, "path");
  const streamContent = stringArgAllowEmpty(
    toolCall.arguments,
    "streamContent",
    "stream_content",
  );
  if (!path || streamContent === undefined) return toolCall;
  return {
    name: "write",
    arguments: {
      path,
      fileText: streamContent,
    },
  };
}

export function decodeLocalAgentServerFrame(
  payload: Uint8Array,
): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1 && field.value instanceof Uint8Array) {
        output.push(...decodeInteractionUpdate(field.value));
      } else if (field.no === 2 && field.value instanceof Uint8Array) {
        const event = decodeExecServerMessage(field.value);
        if (event) output.push(event);
      }
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not decode Cursor local SDK stream";
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return output.length ? output : [{ type: "ignore" }];
}

export function decodeExecServerMessage(
  payload: Uint8Array,
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  if (fields.some((field) => field.no === 10 && field.value instanceof Uint8Array)) {
    return {
      type: "request_context",
      id: numberField(fields, 1) ?? 0,
      execId: stringField(fields, 15),
    };
  }
  return decodeExecServerToolCall(payload, fields);
}

export function decodeInteractionUpdate(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    if (field.no === 1) {
      const text = stringField(decodeProtobufFields(field.value), 1);
      if (text) output.push({ type: "text", text });
    } else if (field.no === 2 || field.no === 3 || field.no === 7) {
      const event = decodeToolCallUpdate(field.value, field.no === 3);
      if (event) output.push(event);
    } else if (field.no === 14) {
      output.push({ type: "done" });
    }
  }
  return output;
}

export function decodeToolCallUpdate(
  payload: Uint8Array,
  completed: boolean,
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const callId = stringField(fields, 1) ?? stableToolCallId(payload);
  const toolCallBytes = bytesField(fields, 2);
  if (!toolCallBytes) return null;
  const decoded = decodeSdkToolCall(toolCallBytes);
  if (!decoded || (completed && decoded.hasResult)) return null;
  return {
    type: "tool_call",
    id: callId,
    toolCall: normalizeSdkToolCallForOpenCode(decoded.toolCall),
  };
}

export function decodeSdkToolCall(
  payload: Uint8Array,
): { toolCall: CursorToolCall; hasResult: boolean } | null {
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = TOOL_CALL_SPECS[field.no];
    if (!spec) continue;
    const toolFields = decodeProtobufFields(field.value);
    const args = bytesField(toolFields, 1);
    const hasResult = toolFields.some((item) => item.no === 2);
    return {
      hasResult,
      toolCall: {
        name: spec.name,
        arguments: args ? decodeToolArgs(spec.argsKind, args) : {},
      },
    };
  }
  return null;
}

export function decodeExecServerToolCall(
  payload: Uint8Array,
  fields = decodeProtobufFields(payload),
): LocalSdkDecodedEvent | null {
  const id = numberField(fields, 1);
  const execId = stringField(fields, 15);
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = EXEC_TOOL_SPECS[field.no];
    if (!spec) continue;
    const args = decodeToolArgs(spec.argsKind, field.value);
    const toolCallId =
      stringArg(args, "toolCallId") ??
      execId ??
      `exec_${id ?? stableToolCallId(payload)}`;
    delete args.toolCallId;
    return {
      type: "tool_call",
      id: toolCallId,
      toolCall: normalizeSdkToolCallForOpenCode({ name: spec.name, arguments: args }),
    };
  }
  return null;
}

export function stableToolCallId(value: Uint8Array): string {
  let hash = 0;
  for (const byte of value.slice(0, 64)) hash = (hash * 31 + byte) >>> 0;
  return `tool_${hash.toString(16)}`;
}
