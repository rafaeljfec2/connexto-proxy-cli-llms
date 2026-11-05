import type { CursorToolCall } from "@agent-runtime-gateway/compatibility-openai";
import type { CursorTextEvent } from "../engine/types.js";

export interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

export interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  stream: AsyncGenerator<CursorTextEvent>;
}

export interface CursorSdkBridgeOutput {
  text?: string;
  toolCalls?: CursorToolCall[];
  agentID?: string;
  runID?: string;
  status?: string;
}

export interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export type ToolCallDecision = boolean | string;

export interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

export type LocalSdkDecodedEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; toolCall: CursorToolCall }
  | { type: "request_context"; id: number; execId?: string }
  | { type: "done" }
  | { type: "ignore" };

export type ArgsKind =
  | "delete"
  | "edit"
  | "glob"
  | "grep"
  | "ls"
  | "mcp"
  | "readExec"
  | "readLints"
  | "readTool"
  | "semSearch"
  | "shell"
  | "write";

export interface ToolSpec {
  name: string;
  argsKind: ArgsKind;
}

export interface ContainerBridgeBinding {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(
      url: string,
      init: { method: string; headers: Headers; body: string; signal?: AbortSignal },
    ): Promise<Response>;
  };
}

export const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const AGENT_MODE_AGENT = 1;
export const DEFAULT_SDK_CLIENT_VERSION = "sdk-1.0.13";
export const SDK_STREAM_START_TIMEOUT_MS = 25_000;
export const DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS = 180_000;
export const SDK_TOOL_RETRY_ATTEMPTS = 3;
