import { exchangeCursorApiKey } from "../engine/auth-api.js";
import type { CursorDeps, CursorEnv, CursorTextEvent } from "../engine/types.js";
import {
  isRecord,
  type CursorImage,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import type { ClientToolSpec, CursorSdkCompletion, ToolCallDecision } from "./types.js";
import { collectTextEvents, type CursorCollectedOutput } from "../engine/stream.js";
import { SDK_TOOL_RETRY_ATTEMPTS } from "./types.js";
import {
  newLocalSdkAgentId,
  newLocalSdkRunId,
  pruneSessions,
  readPersistedSdkSession,
  savePersistedSdkSession,
  sdkSessionIdentity,
  sdkSessions,
} from "./session-store.js";
import {
  retryPromptAfterMissingTool,
  retryPromptAfterUnsupportedTool,
  sdkPrompt,
} from "./prompts.js";
import {
  closeSdkUpload,
  cursorLocalSdkBridgeJson,
  cursorLocalSdkEndpoint,
  cursorLocalSdkRaw,
  hasCursorSdkBridge,
  withSdkStartTimeout,
  writeSdkUpload,
} from "./bridge.js";
import {
  decodeLocalAgentServerFrame,
  isEmittableSdkToolCall,
  normalizeSdkToolCallForOpenCode,
} from "./tool-decoding.js";
import {
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
} from "./proto.js";
import {
  encodeConnectFrame,
  parseConnectProtoFrames,
} from "../engine/connect-proto.js";

export async function createCursorSdkCompletion(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  input: {
    prompt: { text: string; images?: CursorImage[] };
    model?: { id: string };
    sessionKey?: string;
    sessionOwnerKey?: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool?: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): Promise<CursorSdkCompletion> {
  const now = deps.now();
  pruneSessions(now.getTime());
  const sessionIdentity = await sdkSessionIdentity(
    apiKey,
    input.sessionKey ?? "default",
    input.sessionOwnerKey,
  );
  const session =
    sdkSessions.get(sessionIdentity.id) ??
    (await readPersistedSdkSession(env, sessionIdentity.id, now.getTime()));
  const agentId = session?.agentId ?? newLocalSdkAgentId(deps.randomUUID());
  const runId = newLocalSdkRunId(deps.randomUUID());
  const updatedAt = deps.now();

  sdkSessions.set(sessionIdentity.id, { agentId, updatedAt: updatedAt.getTime() });
  await savePersistedSdkSession(env, sessionIdentity, agentId, updatedAt);

  const runInput = {
    agentId,
    runId,
    sessionKey: sessionIdentity.id,
    prompt: sdkPrompt(input.prompt),
    modelId: input.model?.id ?? "composer-2.5",
    workingDirectory: input.workingDirectory,
    clientTools: input.clientTools,
    requiresLocalTool: input.requiresLocalTool === true,
    allowToolCall: input.allowToolCall,
  };

  if (hasCursorSdkBridge(env)) {
    return {
      agentId,
      runId,
      stream: streamCursorLocalSdkBridgeRunWithRetry(env, deps, apiKey, runInput),
    };
  }

  const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
  return {
    agentId,
    runId,
    stream: streamCursorLocalSdkRunWithRetry(env, deps, accessToken, runInput),
  };
}

export async function collectCursorSdkOutput(
  stream: AsyncIterable<CursorTextEvent>,
): Promise<CursorCollectedOutput> {
  return collectTextEvents(stream);
}

export async function* streamCursorLocalSdkRun(
  env: CursorEnv,
  deps: CursorDeps,
  accessToken: string,
  input: {
    agentId: string;
    runId: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const emittedToolCallIds = new Set<string>();
  const requestId = deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeAgentClientRunRequest({
      agentId: input.agentId,
      messageId: input.runId,
      modelId: input.modelId,
      prompt: input.prompt,
    }),
  );
  const runAbort = new AbortController();
  const upload = new TransformStream<Uint8Array, Uint8Array>();
  const uploadWriter = upload.writable.getWriter();
  const runResponsePromise = cursorLocalSdkRaw(
    env,
    deps,
    cursorLocalSdkEndpoint(env),
    accessToken,
    requestId,
    upload.readable,
    runAbort.signal,
  ).then((response) => ({
    source: "run" as const,
    response,
  }));
  let uploadOpen = false;
  if (uploadWriter) {
    await writeSdkUpload(uploadWriter, requestBody);
    uploadOpen = true;
  }

  const selected = await withSdkStartTimeout(runResponsePromise);
  const response = selected.response;

  try {
    for await (const frame of parseConnectProtoFrames(response.body)) {
      for (const event of decodeLocalAgentServerFrame(frame)) {
        if (event.type === "text" && event.text) {
          text += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "tool_call") {
          if (!isEmittableSdkToolCall(event.toolCall)) {
            continue;
          }
          const decision = input.allowToolCall?.(event.toolCall) ?? true;
          if (decision !== true) {
            yield {
              type: "rejected_tool_call",
              toolCall: event.toolCall,
              reason: typeof decision === "string" ? decision : undefined,
            };
            yield { type: "done", finalText: text, toolCalls };
            return;
          }
          if (!emittedToolCallIds.has(event.id)) {
            emittedToolCallIds.add(event.id);
            toolCalls.push(event.toolCall);
            yield { type: "tool_call", toolCall: event.toolCall };
            yield { type: "done", finalText: text, toolCalls };
            return;
          }
        } else if (event.type === "request_context") {
          if (uploadOpen && uploadWriter) {
            await writeSdkUpload(
              uploadWriter,
              encodeConnectFrame(
                encodeAgentClientRequestContextResult(event, {
                  workingDirectory: input.workingDirectory,
                }),
              ),
            );
          }
        } else if (event.type === "done") {
          yield { type: "done", finalText: text, toolCalls };
          return;
        }
      }
    }
  } finally {
    if (uploadOpen && uploadWriter) await closeSdkUpload(uploadWriter);
    runAbort.abort("opencode_sdk_run_finished");
  }

  yield { type: "done", finalText: text, toolCalls };
}

async function* withSdkToolRetry<
  TInput extends {
    runId: string;
    prompt: string;
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
>(
  deps: CursorDeps,
  input: TInput,
  runFn: (attemptInput: TInput) => AsyncGenerator<CursorTextEvent>,
): AsyncGenerator<CursorTextEvent> {
  if (!input.requiresLocalTool && !input.allowToolCall) {
    yield* runFn(input);
    return;
  }

  let attemptInput = input;
  let lastEvents: CursorTextEvent[] = [];
  for (let attempt = 1; attempt <= SDK_TOOL_RETRY_ATTEMPTS; attempt += 1) {
    const events: CursorTextEvent[] = [];
    let sawToolCall = false;
    let rejectedToolCall: CursorToolCall | undefined;
    let rejectedToolReason: string | undefined;
    for await (const event of runFn(attemptInput)) {
      events.push(event);
      if (event.type === "tool_call") sawToolCall = true;
      if (event.type === "rejected_tool_call") {
        rejectedToolCall = event.toolCall;
        rejectedToolReason = event.reason;
      }
    }

    if (sawToolCall) {
      for (const event of events) yield event;
      return;
    }

    lastEvents = events;
    const shouldRetry = rejectedToolCall ?? input.requiresLocalTool;
    if (!shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) break;
    attemptInput = {
      ...input,
      runId: newLocalSdkRunId(deps.randomUUID()),
      prompt: rejectedToolCall
        ? retryPromptAfterUnsupportedTool(
            input.prompt,
            rejectedToolCall,
            rejectedToolReason,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          )
        : retryPromptAfterMissingTool(
            input.prompt,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          ),
    };
  }

  for (const event of lastEvents) yield event;
}

export async function* streamCursorLocalSdkRunWithRetry(
  env: CursorEnv,
  deps: CursorDeps,
  accessToken: string,
  input: {
    agentId: string;
    runId: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  yield* withSdkToolRetry(deps, input, (attemptInput) =>
    streamCursorLocalSdkRun(env, deps, accessToken, attemptInput),
  );
}

export async function* streamCursorLocalSdkBridgeRun(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  const output = await cursorLocalSdkBridgeJson(env, deps, apiKey, input);
  const text = typeof output.text === "string" ? output.text : "";
  const toolCalls: CursorToolCall[] = [];
  const rawToolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];

  if (text) yield { type: "text", text };

  for (const rawToolCall of rawToolCalls) {
    if (!rawToolCall || typeof rawToolCall.name !== "string") continue;
    const toolCall = normalizeSdkToolCallForOpenCode({
      name: rawToolCall.name,
      arguments: isRecord(rawToolCall.arguments) ? rawToolCall.arguments : {},
    });
    if (!isEmittableSdkToolCall(toolCall)) continue;
    const decision = input.allowToolCall?.(toolCall) ?? true;
    if (decision !== true) {
      yield {
        type: "rejected_tool_call",
        toolCall,
        reason: typeof decision === "string" ? decision : undefined,
      };
      yield { type: "done", finalText: text, toolCalls };
      return;
    }
    toolCalls.push(toolCall);
    yield { type: "tool_call", toolCall };
    yield { type: "done", finalText: text, toolCalls };
    return;
  }

  yield { type: "done", finalText: text, toolCalls };
}

export async function* streamCursorLocalSdkBridgeRunWithRetry(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  yield* withSdkToolRetry(deps, input, (attemptInput) =>
    streamCursorLocalSdkBridgeRun(env, deps, apiKey, attemptInput),
  );
}
