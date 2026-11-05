import type { CursorImage } from "../types.js";
import type { PreparedRequest } from "./types.js";
import { HttpError } from "../http.js";
import {
  isRecord,
  expectRecord,
  expectArray,
  includeStreamUsage,
  integerOrNull,
  numberOrNull,
} from "./common.js";
import {
  SYSTEM_DIRECTIVE,
  AGENT_SYSTEM_DIRECTIVE,
  TOOL_SYSTEM_DIRECTIVE,
  RESPONSES_TOOL_SYSTEM_DIRECTIVE,
  AGENT_MODE_PRIMER,
} from "./constants.js";
import { responseToolMetadata, responseToolChoiceMetadata } from "./formatters.js";
import { parseChatTools } from "./tools/specs.js";
import {
  shouldRequireLocalTool,
  hasRequiredLocalToolCall,
  hasRequiredResponseLocalToolCall,
  latestUserTextFromMessages,
  latestUserTextFromResponseInput,
  addWorkspaceActionToUserText,
} from "./tools/workspace.js";
import {
  validateCommonUnsupported,
  appendChatOptions,
  appendResponseOptions,
  contentToTextAndImages,
  toolCallContextFromMessages,
  toolCallContextFromResponseInput,
} from "./transcripts/helpers.js";
import {
  sdkToolResultFeedback,
  rememberOpenCodeToolCalls,
} from "./transcripts/sdk-feedback.js";
import {
  appendChatTools,
  appendResponsesToolInventory,
  appendSdkToolInventory,
  appendWorkspaceMutationRequirement,
  appendSdkWorkspaceMutationRequirement,
  appendResponsesWorkspaceMutationRequirement,
  responseInputWithPrevious,
  responseInputToTextAndImages,
  normalizedResponseInputItems,
} from "./transcripts/builder.js";

export function prepareChatRequest(
  body: unknown,
  cursorModel: { id: string } | undefined,
  options: { forceAgentMode?: boolean } = {},
): PreparedRequest {
  const record = expectRecord(body, "body");
  const messages = expectArray(record.messages, "messages");
  validateCommonUnsupported(record);
  if (record.functions !== undefined) {
    throw new HttpError(
      "Legacy function calling is not supported by this adapter.",
      400,
      "unsupported_parameter",
      "functions",
    );
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const toolContext = toolCallContextFromMessages(messages);
  const agentMode = options.forceAgentMode === true || tools.length > 0;
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : "composer-2.5";
  const latestUserText = latestUserTextFromMessages(messages);
  const workspaceMutationRequired = shouldRequireLocalTool(latestUserText, tools);
  const workspaceMutationDone =
    workspaceMutationRequired &&
    hasRequiredLocalToolCall(messages, tools, latestUserText);
  const transcript: string[] = [
    tools.length
      ? TOOL_SYSTEM_DIRECTIVE
      : agentMode
        ? AGENT_SYSTEM_DIRECTIVE
        : SYSTEM_DIRECTIVE,
  ];
  appendChatTools(transcript, tools, record.tool_choice);
  appendWorkspaceMutationRequirement(
    transcript,
    workspaceMutationRequired,
    workspaceMutationDone,
  );
  transcript.push("", "Conversation:");
  if (agentMode) transcript.push(...AGENT_MODE_PRIMER);
  const images: CursorImage[] = [];
  for (const message of messages) {
    const item = expectRecord(message, "messages[]");
    const role = typeof item.role === "string" ? item.role : "user";
    const { text, images: messageImages } = contentToTextAndImages(item.content, role);
    images.push(...messageImages);
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : "";
      const toolName = typeof item.name === "string" ? item.name : "";
      const label = [
        toolName ? `name=${toolName}` : "",
        toolCallId ? `tool_call_id=${toolCallId}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      transcript.push(
        `TOOL RESULT${label ? ` (${label})` : ""}: ${text ? text : "[empty]"}`,
      );
    } else {
      transcript.push(
        `${role.toUpperCase()}: ${workspaceMutationRequired && role === "user" ? addWorkspaceActionToUserText(text) : text ? text : "[empty]"}`,
      );
    }
    if (Array.isArray(item.tool_calls)) {
      transcript.push(
        `${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`,
      );
    }
  }
  appendChatOptions(transcript, record);
  const text = transcript.join("\n");
  return {
    model,
    cursorModel,
    prompt: {
      text,
      mode: agentMode ? "agent" : "ask",
      ...(images.length ? { images } : {}),
    },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: text.length,
    responseMetadata: {
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p),
    },
    tools,
    requiresLocalTool: false,
    storeResponse: false,
    toolContext,
  };
}

export function prepareOpencodeSdkChatRequest(
  body: unknown,
  cursorModel: { id: string } | undefined,
): PreparedRequest {
  const record = expectRecord(body, "body");
  const messages = expectArray(record.messages, "messages");
  validateCommonUnsupported(record);
  if (record.functions !== undefined) {
    throw new HttpError(
      "Legacy function calling is not supported by this adapter.",
      400,
      "unsupported_parameter",
      "functions",
    );
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const toolContext = toolCallContextFromMessages(messages);
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : "composer-2.5";
  const latestUserText = latestUserTextFromMessages(messages);
  const workspaceMutationRequired = shouldRequireLocalTool(latestUserText, tools);
  const workspaceMutationDone =
    workspaceMutationRequired &&
    hasRequiredLocalToolCall(messages, tools, latestUserText);
  const transcript: string[] = [
    "You are running through an SDK-compatible OpenCode harness.",
    "OpenCode owns local tool execution. When local inspection, shell commands, or file changes are needed, request a tool call and wait for the tool result.",
    "When the conversation includes LOCAL OPENCODE TOOL RESULT records, treat them as completed SDK tool_call results for your previous tool requests and continue from those results.",
    "If the user explicitly names an allowed client tool, use that tool. Non-builtin client tools and OpenCode MCP/server tools are called through SDK mcp with providerIdentifier, toolName, and args.",
    "For creating new files when no specific client tool is requested, request write calls with both path and fileText. Do not use edit for new files or emit edit calls without complete replacement details.",
    "For project scaffolding when no specific client tool is requested, prefer shell with a complete command that creates files using heredocs, installs dependencies, and runs tests; shell requires the command argument.",
    "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately; do not request a foreground server command.",
    "Do not say that agent mode or tools are unavailable. Do not ask the user to switch modes.",
  ];
  appendSdkToolInventory(transcript, tools, record.tool_choice, toolContext);
  appendSdkWorkspaceMutationRequirement(
    transcript,
    workspaceMutationRequired,
    workspaceMutationDone,
    tools,
    latestUserText,
  );
  transcript.push("", "Conversation:");

  const images: CursorImage[] = [];
  const toolCallById = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  for (const message of messages) {
    const item = expectRecord(message, "messages[]");
    const role = typeof item.role === "string" ? item.role : "user";
    const { text, images: messageImages } = contentToTextAndImages(item.content, role);
    images.push(...messageImages);
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : "";
      const toolName = typeof item.name === "string" ? item.name : "";
      const label = [
        toolName ? `name=${toolName}` : "",
        toolCallId ? `tool_call_id=${toolCallId}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      transcript.push(
        `TOOL RESULT${label ? ` (${label})` : ""}: ${text ? text : "[empty]"}`,
      );
      transcript.push(
        `LOCAL OPENCODE TOOL RESULT: ${JSON.stringify(sdkToolResultFeedback(toolCallId, toolName, text, toolCallById, tools))}`,
      );
    } else {
      transcript.push(`${role.toUpperCase()}: ${text ? text : "[empty]"}`);
    }
    if (Array.isArray(item.tool_calls)) {
      transcript.push(
        `${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`,
      );
      rememberOpenCodeToolCalls(item.tool_calls, toolCallById);
    }
  }
  appendChatOptions(transcript, record);
  const text = transcript.join("\n");
  return {
    model,
    cursorModel,
    prompt: { text, mode: "agent", ...(images.length ? { images } : {}) },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: text.length,
    responseMetadata: {
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p),
    },
    tools,
    requiresLocalTool: workspaceMutationRequired && !workspaceMutationDone,
    storeResponse: false,
    toolContext,
  };
}

export function prepareResponsesRequest(
  body: unknown,
  cursorModel: { id: string } | undefined,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] } = {},
): PreparedRequest {
  const record = expectRecord(body, "body");
  validateCommonUnsupported(record);
  if (record.background === true) {
    throw new HttpError(
      "background responses are not supported.",
      400,
      "unsupported_parameter",
      "background",
    );
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const toolContext = toolCallContextFromResponseInput(
    record.input,
    record.instructions,
  );
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : "composer-2.5";
  const latestUserText = latestUserTextFromResponseInput(record.input);
  const workspaceMutationRequired = shouldRequireLocalTool(latestUserText, tools);
  const workspaceMutationDone =
    workspaceMutationRequired &&
    hasRequiredResponseLocalToolCall(record.input, tools, latestUserText);
  const transcript: string[] = [
    tools.length ? RESPONSES_TOOL_SYSTEM_DIRECTIVE : SYSTEM_DIRECTIVE,
  ];
  appendResponsesToolInventory(transcript, tools, record.tool_choice, toolContext);
  appendResponsesWorkspaceMutationRequirement(
    transcript,
    workspaceMutationRequired,
    workspaceMutationDone,
    tools,
    latestUserText,
  );
  const instructions =
    typeof record.instructions === "string" ? record.instructions.trim() : "";
  if (instructions) transcript.push("", `INSTRUCTIONS:\n${instructions}`);
  transcript.push("", "INPUT:");
  const effectiveInput = responseInputWithPrevious(record.input, options);
  const { text, images } = responseInputToTextAndImages(effectiveInput, tools);
  transcript.push(text ? text : "[empty]");
  appendResponseOptions(transcript, record);
  const prompt = transcript.join("\n");
  const previousResponseId =
    typeof record.previous_response_id === "string" &&
    record.previous_response_id.trim()
      ? record.previous_response_id.trim()
      : undefined;
  const storeResponse = record.store !== false;
  return {
    model,
    cursorModel,
    prompt: {
      text: prompt,
      mode: tools.length ? "agent" : "ask",
      ...(images.length ? { images } : {}),
    },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: prompt.length,
    responseMetadata: {
      instructions: instructions ? instructions : null,
      max_output_tokens: integerOrNull(record.max_output_tokens),
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p),
      text: isRecord(record.text) ? record.text : { format: { type: "text" } },
      previous_response_id: previousResponseId ?? null,
      store: storeResponse,
      ...(tools.length
        ? {
            tools: responseToolMetadata(tools),
            tool_choice: responseToolChoiceMetadata(record.tool_choice),
          }
        : {}),
    },
    tools,
    requiresLocalTool: workspaceMutationRequired && !workspaceMutationDone,
    previousResponseId,
    storeResponse,
    responseInputItems: normalizedResponseInputItems(record.input),
    toolContext,
  };
}
