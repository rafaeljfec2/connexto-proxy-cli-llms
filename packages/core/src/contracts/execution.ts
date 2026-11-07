import type { ProviderCredential } from "./model.js";

export interface AgentImageInput {
  readonly mimeType: string;
  /** Base64 payload of the image. */
  readonly data: string;
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
