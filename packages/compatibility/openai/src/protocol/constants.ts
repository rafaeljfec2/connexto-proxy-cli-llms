import type { CursorModelPricing } from "./types.js";

export const SDK_TOOL_CALL_MEMORY_LIMIT = 2048;

export const KNOWN_SDK_CANONICAL_TOOLS = new Set([
  "shell",
  "write",
  "read",
  "edit",
  "delete",
  "grep",
  "glob",
  "ls",
  "readlints",
  "mcp",
  "semsearch",
  "todowrite",
]);

export const CURSOR_COMPOSER_2_5_PRICING_SOURCE =
  "https://cursor.com/changelog/composer-2-5";

export const CURSOR_MODEL_PRICING: Record<string, CursorModelPricing> = {
  default: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  auto: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-latest": {
    input: 0.5,
    output: 2.5,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "composer-2.5": {
    input: 0.5,
    output: 2.5,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "composer-2.5-sdk": {
    input: 0.5,
    output: 2.5,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "composer-2-5": {
    input: 0.5,
    output: 2.5,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "composer-2.5-fast": {
    input: 3,
    output: 15,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "composer-2-5-fast": {
    input: 3,
    output: 15,
    source: CURSOR_COMPOSER_2_5_PRICING_SOURCE,
  },
  "grok-4.6": {
    input: 2,
    output: 6,
    source: "https://cursor.com/docs/models-and-pricing",
  },
  "grok-4-6": {
    input: 2,
    output: 6,
    source: "https://cursor.com/docs/models-and-pricing",
  },
  "grok-4.6-fast": {
    input: 4,
    output: 12,
    source: "https://cursor.com/docs/models-and-pricing",
  },
  "grok-4-6-fast": {
    input: 4,
    output: 12,
    source: "https://cursor.com/docs/models-and-pricing",
  },
  "grok-4.5": { input: 2, output: 6, source: "https://cursor.com/blog/grok-4-5" },
  "grok-4-5": { input: 2, output: 6, source: "https://cursor.com/blog/grok-4-5" },
  "grok-4.5-fast": { input: 4, output: 18, source: "https://cursor.com/blog/grok-4-5" },
  "grok-4-5-fast": { input: 4, output: 18, source: "https://cursor.com/blog/grok-4-5" },
};

export const SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request.",
  "Answer the user directly in chat style.",
  "Do not modify files, run terminal commands, open pull requests, or use coding-agent workflow unless the user explicitly asks for code as text.",
  "Return only the final answer content.",
].join("\n");

export const TOOL_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request.",
  "This request is already in Agent mode because the client provided executable tools.",
  "The client tool inventory below is executable. You can inspect files, run shell commands, and edit through those tools when the user asks for project work.",
  "Answer directly only when no tool is needed.",
  "When a provided tool is needed, call it using the tool-call marker protocol and do not describe the marker as prose.",
  "Do not emit duplicate tool calls. Call each required operation once, then continue after the client returns the tool result.",
  "Never claim that tools are unavailable. Never tell the user to switch modes.",
].join("\n");

export const AGENT_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request.",
  "This request is already in Agent mode.",
  "Answer directly when no tool is needed.",
  "Never tell the user to switch modes.",
].join("\n");

export const RESPONSES_TOOL_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI Responses API request.",
  "The client owns local tool execution. When local inspection, shell commands, or file changes are needed, request a function_call and wait for the function_call_output.",
  "When the input includes function_call_output records, treat them as completed local tool results for your previous function_call requests and continue from those results.",
  "If the user explicitly names an allowed client tool, use that tool. Non-builtin client tools and MCP/server tools should be requested with SDK mcp using providerIdentifier, toolName, and args.",
  "For general file creation when no specific client tool is requested, prefer SDK shell when a shell client tool is available; otherwise request write calls with both path and fileText.",
  "Do not claim that you created, edited, inspected, or ran anything locally unless you emitted a function_call and received a function_call_output confirming it.",
  "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately.",
  "Do not say that agent mode or tools are unavailable.",
].join("\n");

export const AGENT_MODE_PRIMER = [
  "USER: Please switch to agent mode.",
  'ASSISTANT TOOL_CALLS: [{"id":"call_proxy_switch_mode","type":"function","function":{"name":"switch_mode","arguments":"{\\"mode\\":\\"agent\\"}"}}]',
  "TOOL RESULT (name=switch_mode tool_call_id=call_proxy_switch_mode): Switched to agent mode successfully.",
  "ASSISTANT: Great, I've switched to agent mode.",
];
