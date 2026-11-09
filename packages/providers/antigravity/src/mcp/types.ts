import type { AgentToolSpec } from "@agent-runtime-gateway/core";

export type ToolPermissionLevel = "read_only" | "state_changing" | "destructive";

export interface ToolPolicy {
  readonly permissionLevel: ToolPermissionLevel;
  readonly allowed?: boolean;
}

export interface McpBridgeToolCallRequest {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface McpBridgeToolCallResult {
  readonly output: string;
  readonly isError?: boolean;
}

export type ToolExecutionMode = "delegate_to_client" | "internal_executor";

export type McpToolExecutor = (
  call: McpBridgeToolCallRequest,
) => Promise<McpBridgeToolCallResult>;

export interface AntigravityMcpBridgeOptions {
  readonly sessionId: string;
  readonly tools: readonly AgentToolSpec[];
  readonly mode?: ToolExecutionMode;
  readonly policies?: Record<string, ToolPolicy>;
  readonly executor?: McpToolExecutor;
  readonly timeoutMs?: number;
  readonly allowParallelToolCalls?: boolean;
  readonly onToolCall?: (call: McpBridgeToolCallRequest) => void;
  readonly onToolResult?: (callId: string, result: McpBridgeToolCallResult) => void;
}

export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: readonly { readonly name: string; readonly value: string }[];
}

