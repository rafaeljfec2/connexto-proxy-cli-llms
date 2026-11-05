import type { CursorImage, CursorToolCall } from "../../types.js";
import type { OpenAiToolSpec, ToolCallContext } from "../types.js";
import { isRecord, expectRecord } from "../common.js";
import { toolInventoryRecord, mcpTargetForClientToolName } from "../tools/specs.js";
import { toolArgumentsSatisfySchema } from "../tools/schema.js";
import { hasCompatibleTool, resolveToolSpec } from "../tools/resolution.js";
import { normalizeToolArguments } from "../tools/normalizers.js";
import {
  directToolChoiceHint,
  explicitlyRequestedToolName,
  requestedToolHint,
} from "../tools/hints.js";
import { toolChoiceFunctionName, parseToolCallArguments } from "../tools/workspace.js";
import { normalizeResponseInputItem } from "../formatters.js";
import { contentToTextAndImages, responseInputArray } from "./helpers.js";
import { sdkToolResultFeedback } from "./sdk-feedback.js";

export function appendChatTools(
  transcript: string[],
  tools: OpenAiToolSpec[],
  toolChoice: unknown,
): void {
  if (!tools.length) return;
  transcript.push(
    "",
    "CLIENT TOOL INVENTORY:",
    `Allowed tool names: ${tools.map((tool) => tool.name).join(", ")}`,
    "Use only the exact tool names above. Use the argument names from each tool's JSON schema.",
    "If the task requires creating or changing files, call write/edit/bash. Do not provide a code block and ask the user to save it.",
    "To call one tool, output this exact shape and no explanatory prose:",
    "<|tool_calls_begin|><|tool_call_begin|>",
    "tool_name",
    "<|tool_sep|>argument_name",
    "argument value",
    "<|tool_call_end|><|tool_calls_end|>",
    "Do not call switch_mode; that setup already completed.",
  );
  for (const tool of tools) {
    transcript.push(
      JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: false })),
    );
  }
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    transcript.push(directToolChoiceHint(toolChoice.function.name));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

export function appendResponsesToolInventory(
  transcript: string[],
  tools: OpenAiToolSpec[],
  toolChoice: unknown,
  context?: ToolCallContext,
): void {
  if (!tools.length) return;
  transcript.push(
    "",
    "LOCAL TOOL INVENTORY:",
    `Client tool targets: ${tools.map((tool) => tool.name).join(", ")}`,
    "These are client execution targets, not the names you should emit.",
    "For local work, emit only SDK tool names from the SDK TOOL ROUTING MAP. The adapter forwards those SDK calls to the matching client tool names and schemas.",
    "Prefer built-in SDK routes for shell/read/write/edit/glob/grep/ls-style client tools. Use SDK mcp for unique client tools and MCP/server tools.",
    "When the user names a specific allowed client tool, use the matching SDK TOOL ROUTING MAP route and do not substitute a different tool.",
    'If you need a local tool, emit the tool call before prose. Do not write progress text such as "creating the file" instead of calling a tool.',
  );
  if (hasCompatibleTool("shell", tools)) {
    transcript.push(
      "A shell client tool is available. For general file creation or overwrite requests, prefer an SDK shell call using mkdir -p and a quoted heredoc.",
    );
  }
  for (const tool of tools) {
    transcript.push(JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: true })));
  }
  appendSdkRoutingMap(transcript, tools, context);
  const selected = toolChoiceFunctionName(toolChoice);
  if (selected) {
    transcript.push(requestedToolHint(selected));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

export function appendSdkToolInventory(
  transcript: string[],
  tools: OpenAiToolSpec[],
  toolChoice: unknown,
  context?: ToolCallContext,
): void {
  if (!tools.length) return;
  transcript.push(
    "",
    "OPENCODE TOOL INVENTORY:",
    `Client tool targets: ${tools.map((tool) => tool.name).join(", ")}`,
    "These are OpenCode execution targets, not the names you should emit.",
    "For local work, emit only SDK tool names from the SDK TOOL ROUTING MAP. The adapter forwards those SDK calls to the matching OpenCode tool names and schemas.",
    "Prefer built-in SDK routes for shell/read/write/edit/glob/grep/ls-style OpenCode tools. Use SDK mcp for unique OpenCode tools and MCP/server tools.",
    "When the user names a specific allowed client tool, use the matching SDK TOOL ROUTING MAP route and do not substitute a different tool.",
    "For general local work, prefer shell/read/write/edit/glob/grep/ls style tool requests when those capabilities are present.",
  );
  for (const tool of tools) {
    transcript.push(JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: true })));
  }
  appendSdkRoutingMap(transcript, tools, context);
  if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    typeof toolChoice.function.name === "string"
  ) {
    transcript.push(requestedToolHint(toolChoice.function.name));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

export function appendSdkRoutingMap(
  transcript: string[],
  tools: OpenAiToolSpec[],
  context?: ToolCallContext,
): void {
  const routes = sdkRoutingRecords(tools, context);
  if (!routes.length) return;
  transcript.push(
    "SDK TOOL ROUTING MAP:",
    "Use these SDK tool names; the adapter forwards them to the listed client tool and argument shape.",
  );
  for (const route of routes) {
    transcript.push(JSON.stringify(route));
  }
}

export function sdkRoutingRecords(
  tools: OpenAiToolSpec[],
  context?: ToolCallContext,
): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [];
  for (const sample of sdkRoutingSamples()) {
    const tool = resolveToolSpec(sample.name, sample.arguments, tools);
    if (!tool) continue;
    const clientArgs = normalizeToolArguments(
      sample.arguments,
      tool,
      sample.name,
      0,
      context,
    );
    if (!toolArgumentsSatisfySchema(clientArgs, tool)) continue;
    routes.push({
      sdk: sample.name,
      client: tool.name,
      clientArgs,
    });
  }
  for (const tool of tools) {
    const target = mcpTargetForClientToolName(tool.name, { includeMapped: false });
    if (!target) continue;
    routes.push({
      sdk: "mcp",
      client: tool.name,
      sdkArgs: {
        providerIdentifier: target.provider,
        toolName: target.toolName,
        args: "match client schema",
      },
    });
  }
  return routes.slice(0, 24);
}

export function sdkRoutingSamples(): CursorToolCall[] {
  return [
    {
      name: "shell",
      arguments: {
        command: "<command>",
        workingDirectory: "/workspace",
        timeout: 120_000,
      },
    },
    { name: "read", arguments: { path: "src/App.tsx", offset: 1, limit: 80 } },
    { name: "write", arguments: { path: "src/App.tsx", fileText: "<file content>" } },
    {
      name: "edit",
      arguments: {
        path: "src/App.tsx",
        oldString: "<old text>",
        newString: "<new text>",
      },
    },
    { name: "delete", arguments: { path: "src/old.tsx" } },
    { name: "glob", arguments: { targetDirectory: ".", globPattern: "**/*" } },
    { name: "grep", arguments: { pattern: "<pattern>", path: ".", glob: "*" } },
    { name: "ls", arguments: { path: "." } },
    { name: "readLints", arguments: { paths: ["src/App.tsx"] } },
    { name: "semSearch", arguments: { query: "<query>", targetDirectories: ["."] } },
    {
      name: "todowrite",
      arguments: {
        todos: [{ content: "<task>", status: "in_progress", priority: "medium" }],
      },
    },
  ];
}

export function appendResponsesWorkspaceMutationRequirement(
  transcript: string[],
  required: boolean,
  done: boolean,
  tools: OpenAiToolSpec[],
  latestUserText: string,
): void {
  if (!required) return;
  const requestedTool = explicitlyRequestedToolName(latestUserText, tools);
  transcript.push(
    "",
    "LOCAL TOOL REQUIRED FOR THE LATEST USER REQUEST:",
    "The latest user request requires local filesystem or shell execution. Emit exactly one SDK tool call next and no prose.",
    done
      ? "A file-mutating tool call has already been made. Continue from the returned function_call_output and run verification commands when needed."
      : requestedTool
        ? requestedToolHint(requestedTool)
        : hasCompatibleTool("shell", tools)
          ? "Use SDK shell when it maps to the client shell/bash tool. For unique shell-like client tools, use the SDK mcp route. For creating or overwriting files, run mkdir -p for parent directories and write files with quoted heredocs. After function_call_output returns, continue."
          : "Use SDK write when it maps to the client write tool. For unique writer tools, use the SDK mcp route with matching arguments. After function_call_output returns, continue.",
  );
}

export function appendWorkspaceMutationRequirement(
  transcript: string[],
  required: boolean,
  done: boolean,
): void {
  if (!required) return;
  transcript.push(
    "",
    "WORKSPACE MUTATION REQUIRED:",
    "The user is asking you to create or change project files. You must perform the change with the client's write/edit/bash tools.",
    "If the workspace is empty, create the necessary starter files directly. Do not output a standalone file for the user to save.",
    done
      ? "A file-mutating tool call has already been made. After tool results confirm the change, briefly summarize what you created."
      : "No file-mutating tool call has been made yet. Your next assistant response must be a write/edit/bash tool call, not prose.",
  );
}

export function appendSdkWorkspaceMutationRequirement(
  transcript: string[],
  required: boolean,
  done: boolean,
  tools: OpenAiToolSpec[],
  latestUserText: string,
): void {
  if (!required) return;
  const requestedTool = explicitlyRequestedToolName(latestUserText, tools);
  transcript.push(
    "",
    "SDK WORKSPACE MUTATION REQUIRED:",
    "The user is asking you to create or change project files. You must perform the change with local OpenCode tools.",
    "If the workspace is empty, stop probing after the first empty result and create the project files.",
    requestedTool
      ? requestedToolHint(requestedTool)
      : "Use SDK shell/write when those routes map to client bash/write. Use SDK mcp for unique writer tools. Do not use edit for new files.",
    done
      ? "A file-mutating tool call has already been made. Continue from the returned tool results and run verification commands when needed."
      : requestedTool
        ? "No file-mutating tool call has been made yet. Your next tool call must use the explicitly requested client tool, not shell/write as a substitute."
        : "No file-mutating tool call has been made yet. Your next tool call must be write or shell with complete arguments, not glob, edit, or prose.",
  );
}

export function responseInputToTextAndImages(
  input: unknown,
  tools: OpenAiToolSpec[] = [],
): { text: string; images: CursorImage[] } {
  if (typeof input === "string") return { text: input, images: [] };
  if (!Array.isArray(input))
    return { text: input === undefined ? "" : JSON.stringify(input), images: [] };

  const lines: string[] = [];
  const images: CursorImage[] = [];
  const toolCallById = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  for (const item of input) {
    if (typeof item === "string") {
      lines.push(item);
      continue;
    }
    const record = expectRecord(item, "input[]");
    if (record.type === "message" || typeof record.role === "string") {
      const role = typeof record.role === "string" ? record.role : "user";
      const content = contentToTextAndImages(record.content, role);
      lines.push(`${role.toUpperCase()}: ${content.text ? content.text : "[empty]"}`);
      images.push(...content.images);
    } else if (record.type === "function_call") {
      const callId =
        typeof record.call_id === "string" && record.call_id.trim()
          ? record.call_id.trim()
          : typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `call_response_${toolCallById.size}`;
      const name = typeof record.name === "string" ? record.name : "unknown";
      const args = parseToolCallArguments(record.arguments);
      toolCallById.set(callId, { name, args });
      lines.push(
        `ASSISTANT TOOL_CALLS: ${JSON.stringify([{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }])}`,
      );
    } else if (record.type === "function_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      const output = responseToolOutputText(record.output);
      const remembered = toolCallById.get(callId);
      const label = [
        remembered?.name ? `name=${remembered.name}` : "",
        callId ? `tool_call_id=${callId}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `TOOL RESULT${label ? ` (${label})` : ""}: ${output ? output : "[empty]"}`,
      );
      lines.push(
        `LOCAL TOOL RESULT: ${JSON.stringify(sdkToolResultFeedback(callId, remembered?.name ?? "", output, toolCallById, tools))}`,
      );
    } else {
      lines.push(JSON.stringify(record));
    }
  }
  return { text: lines.join("\n"), images };
}

export function responseInputWithPrevious(
  input: unknown,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] },
): unknown {
  const previous = [
    ...(options.previousInputItems ?? []),
    ...(options.previousOutput ?? []),
  ];
  if (!previous.length) return input;
  return [...previous, ...responseInputArray(input)];
}

export function normalizedResponseInputItems(input: unknown): unknown[] {
  return responseInputArray(input).map(normalizeResponseInputItem);
}

export function responseToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}
