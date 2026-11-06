import type { SpawnFn } from "./spawn-types.js";

export type JsonRpcId = number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorPayload;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export const JSON_RPC_ERROR_AUTH_REQUIRED = -32000;

export interface AgentInfo {
  readonly name: string;
  readonly version: string;
}

export interface AuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly type?: string;
}

export interface PromptCapabilities {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
}

export interface AgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: PromptCapabilities;
  readonly sessionCapabilities?: Readonly<Record<string, unknown>>;
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: AgentCapabilities;
  readonly agentInfo: AgentInfo;
  readonly authMethods: readonly AuthMethod[];
}

export interface ContentBlockBase {
  readonly type: string;
}

export interface TextContentBlock extends ContentBlockBase {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContentBlock extends ContentBlockBase {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface PromptText {
  readonly type: "text";
  readonly text: string;
}

export interface PromptImage {
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}

export type PromptContentBlock = PromptText | PromptImage;

export type StopReason = string;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cachedWriteTokens: number;
  readonly thoughtTokens: number;
  readonly totalTokens: number;
}

export interface PromptResult {
  readonly stopReason: StopReason;
  readonly usage?: TokenUsage;
}

export interface AgentMessageChunkUpdate {
  readonly sessionUpdate: "agent_message_chunk";
  readonly content: Readonly<{ type: string; text?: string }>;
}

export interface GenericSessionUpdate {
  readonly sessionUpdate: string;
  readonly [key: string]: unknown;
}

export type AgentSessionUpdate =
  AgentMessageChunkUpdate | AgentThoughtChunkUpdate | GenericSessionUpdate;

export interface AgentThoughtChunkUpdate {
  readonly sessionUpdate: "agent_thought_chunk";
  readonly content: Readonly<{ type: string; text?: string }>;
}

export interface SessionUpdateParams {
  readonly sessionId: string;
  readonly update: AgentSessionUpdate;
}

export interface SessionConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

export interface SessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type: string;
  readonly currentValue: string | boolean;
  readonly options?: readonly SessionConfigSelectOption[];
}

export interface NewSessionResult {
  readonly sessionId: string;
  readonly configOptions?: readonly SessionConfigOption[];
}

export interface ListSessionsResult {
  readonly sessions: readonly Readonly<
    { sessionId: string } & Record<string, unknown>
  >[];
}

export type SessionUpdateListener = (params: SessionUpdateParams) => void;

export type InvalidLineListener = (line: string) => void;

export type NotificationListener = (method: string, params: unknown) => void;

export type AgentRequestResponse =
  { result: unknown } | { error: { code: number; message: string } };

export type AgentRequestListener = (
  id: number,
  method: string,
  params: unknown,
) => AgentRequestResponse | undefined;

export interface AcpClientTimeouts {
  readonly initializeMs?: number;
  readonly authMs?: number;
  readonly sessionLifecycleMs?: number;
  readonly promptTurnMs?: number;
  readonly processGraceMs?: number;
}

export interface AcpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface AcpClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly clientInfo?: AcpClientInfo;
  readonly authMethodId?: string;
  readonly timeouts?: AcpClientTimeouts;
  readonly spawnFn?: SpawnFn;
  readonly onExit?: (exitCode: number | null, signal: string | null) => void;
  readonly onInvalidLine?: InvalidLineListener;
  readonly onNotification?: NotificationListener;
}
