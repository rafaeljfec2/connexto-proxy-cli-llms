import type { CursorToolCall } from "@agent-runtime-gateway/compatibility-openai";

export interface CursorEnv {
  CURSOR_API_BASE?: string;
  CURSOR_BACKEND_BASE_URL?: string;
  CURSOR_CHAT_ENDPOINT?: string;
  CURSOR_CLIENT_VERSION?: string;
  CURSOR_LOCAL_AGENT_ENDPOINT?: string;
  CURSOR_SDK_BRIDGE_CONTAINER?: unknown;
  CURSOR_SDK_BRIDGE_URL?: string;
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
  ENCRYPTION_KEY?: string;
  DB?: {
    prepare: (query: string) => {
      bind: (...args: unknown[]) => {
        first: <T>() => Promise<T | null>;
        run: () => Promise<unknown>;
      };
    };
  };
}

export type Env = CursorEnv;

export interface CursorDeps {
  fetch: typeof fetch;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

export type Deps = CursorDeps;

export interface CursorModelResponse {
  items?: Array<{ id: string; displayName?: string; aliases?: string[] }>;
}

export interface CursorAccessTokenResponse {
  accessToken?: string;
}

export interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

export interface EncodedCursorImage {
  data: Uint8Array;
  dimension?: { width: number; height: number };
  uuid: string;
}

export interface ProtoField {
  no: number;
  value: number | Uint8Array;
}

export type CursorTextEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: CursorToolCall }
  | { type: "rejected_tool_call"; toolCall: CursorToolCall; reason?: string }
  | { type: "done"; finalText: string; toolCalls: CursorToolCall[] };

export const defaultCursorDeps: CursorDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

export function defaultCursorEnv(): CursorEnv {
  return {
    CURSOR_API_BASE: process.env.CURSOR_API_BASE ?? "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL,
    CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION ?? "2.6.22",
    CURSOR_LOCAL_AGENT_ENDPOINT: process.env.CURSOR_LOCAL_AGENT_ENDPOINT,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "composer-api-local-secret",
  };
}
