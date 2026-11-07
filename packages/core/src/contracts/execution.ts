import type { ProviderCredential } from "./model.js";

export interface AgentImageInput {
  readonly mimeType: string;
  /** Base64 payload of the image. */
  readonly data: string;
}

export type CursorExecutionMode = "edge_owned" | "local_runtime";

export interface CursorClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Cursor-only execution hints set by the HTTP layer for hub-integrated clients. */
export interface CursorExecutionContext {
  mode: CursorExecutionMode;
  promptMode: "agent" | "ask";
  clientTools?: readonly CursorClientToolSpec[];
  requiresLocalTool?: boolean;
}

export interface AgentExecutionInput {
  credential: ProviderCredential;
  model: string;
  sessionId: string;
  message: string;
  /**
   * Optional normalized image content (providers without image support ignore
   * it). Providers receiving them forward the blocks to the upstream runtime.
   */
  images?: readonly AgentImageInput[];
  workingDirectory?: string;
  cursor?: CursorExecutionContext;
  signal?: AbortSignal;
}

export type AgentRunStatus = "completed" | "failed" | "cancelled";

export interface AgentResult {
  status: AgentRunStatus;
  output?: {
    text: string;
  };
  error?: {
    message: string;
    code?: string;
  };
}

export interface AgentRun {
  id: string;
  events: AsyncIterable<AgentEvent>;
  wait(): Promise<AgentResult>;
  cancel(): Promise<void>;
}

export type AgentEvent =
  | AgentRunStartedEvent
  | AgentMessageDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent
  | AgentRunCancelledEvent;

export interface AgentRunStartedEvent {
  type: "run.started";
  runId: string;
  providerId: string;
  sessionId: string;
  model: string;
}

export interface AgentMessageDeltaEvent {
  type: "message.delta";
  runId: string;
  delta: string;
}

export interface AgentToolCallEvent {
  type: "tool.call";
  runId: string;
  toolName: string;
  callId: string;
  /** JSON-encoded tool arguments when provided by the upstream runtime. */
  arguments?: string;
}

export interface AgentToolResultEvent {
  type: "tool.result";
  runId: string;
  callId: string;
  output: string;
}

export interface AgentRunCompletedEvent {
  type: "run.completed";
  runId: string;
}

export interface AgentRunFailedEvent {
  type: "run.failed";
  runId: string;
  message: string;
  code?: string;
}

export interface AgentRunCancelledEvent {
  type: "run.cancelled";
  runId: string;
}
