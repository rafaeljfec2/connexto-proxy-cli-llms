import {
  HttpError,
  isRecord,
  parseSse,
  resolveCursorModel,
  type CursorCompletion,
  type CursorPrompt,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import type { CursorDeps, CursorEnv, CursorTextEvent } from "./types.js";
import {
  ComposerOutputFilter,
  ComposerToolCallFilter,
  ThinkingTextExtractor,
  stripComposerControlTokens,
} from "./filters.js";
import { resolveCursorImages } from "./images.js";
import {
  decodeCursorChatFrame,
  encodeConnectFrame,
  encodeCursorChatRequest,
  parseConnectProtoFrames,
} from "./connect-proto.js";
import {
  cursorChatEndpoint,
  cursorInternalHeaders,
  cursorInternalRaw,
  exchangeCursorApiKey,
  getCursorAccountIdentity,
  stableUuid,
} from "./auth-api.js";

export interface CursorCollectedOutput {
  text: string;
  toolCalls: CursorToolCall[];
}

export { resolveCursorModel };

export async function createCursorCompletion(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  input: { prompt: CursorPrompt; model?: { id: string }; conversationKey?: string },
): Promise<CursorCompletion> {
  const images = await resolveCursorImages(input.prompt.images ?? [], deps);
  const cursorIdentity = await getCursorAccountIdentity(env, deps, apiKey);
  const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
  const requestId = deps.randomUUID();
  const conversationId = input.conversationKey
    ? await stableUuid(
        "composer-api-conversation",
        `${cursorIdentity}:${input.conversationKey}`,
      )
    : deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeCursorChatRequest({
      prompt: input.prompt,
      images,
      model: input.model?.id ?? "composer-2.5",
      requestId,
      conversationId,
      messageId: deps.randomUUID(),
    }),
  );
  const response = await cursorInternalRaw(
    env,
    deps,
    accessToken,
    cursorChatEndpoint(env),
    {
      method: "POST",
      headers: await cursorInternalHeaders(env, accessToken, cursorIdentity, requestId),
      body: requestBody.buffer as ArrayBuffer,
    },
  );
  return { requestId, conversationId, stream: response };
}

export async function* streamCursorText(
  response: Response,
): AsyncGenerator<CursorTextEvent> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/connect+proto")) {
    yield* streamLegacyAgentText(response);
    return;
  }

  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const thinking = new ThinkingTextExtractor();
  const output = new ComposerOutputFilter();
  const toolMarkers = new ComposerToolCallFilter();

  function* recordAndYield(
    events: Iterable<CursorTextEvent>,
  ): Generator<CursorTextEvent> {
    for (const event of events) {
      if (event.type === "text") {
        text += event.text;
      } else if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
      }
      yield event;
    }
  }

  const emit = function* (value: string): Generator<CursorTextEvent> {
    for (const delta of output.push(value)) {
      yield* recordAndYield(toolMarkers.push(delta));
    }
  };

  for await (const frame of parseConnectProtoFrames(response.body)) {
    const event = decodeCursorChatFrame(frame);
    if (event.type === "error")
      throw new HttpError(event.message, 502, "cursor_stream_error");
    if (event.type === "tool_call") {
      if (event.toolCall) {
        toolCalls.push(event.toolCall);
        yield { type: "tool_call", toolCall: event.toolCall };
      }
      continue;
    }
    if (event.type === "text" && event.text) {
      yield* emit(event.text);
    }
    if (event.type === "thinking" && event.text) {
      for (const delta of thinking.push(event.text)) {
        yield* emit(delta);
      }
    }
  }
  const flushed = thinking.flush();
  if (flushed) {
    yield* emit(flushed);
  }
  for (const delta of output.flush()) {
    yield* recordAndYield(toolMarkers.push(delta));
  }
  yield* recordAndYield(toolMarkers.flush());
  yield { type: "done", finalText: text, toolCalls };
}

export async function* streamLegacyAgentText(
  response: Response,
): AsyncGenerator<CursorTextEvent> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  let mode: "unknown" | "assistant" | "delta" = "unknown";
  const toolMarkers = new ComposerToolCallFilter();

  function* recordAndYield(
    events: Iterable<CursorTextEvent>,
  ): Generator<CursorTextEvent> {
    for (const event of events) {
      if (event.type === "text") {
        text += event.text;
      } else if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
      }
      yield event;
    }
  }

  const emit = function* (value: string): Generator<CursorTextEvent> {
    yield* recordAndYield(toolMarkers.push(value));
  };

  for await (const event of parseSse(response.body)) {
    if (event.event === "done") break;
    if (!event.data) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }

    if (event.event === "interaction_update" && isRecord(payload)) {
      const type = payload.type;
      if (
        type === "text-delta" &&
        typeof payload.text === "string" &&
        mode !== "assistant"
      ) {
        mode = "delta";
        const delta = stripComposerControlTokens(payload.text);
        if (delta) yield* emit(delta);
      } else if (
        type === "summary" &&
        typeof payload.summary === "string" &&
        !text &&
        mode === "unknown"
      ) {
        text = stripComposerControlTokens(payload.summary);
      }
      continue;
    }

    if (
      event.event === "assistant" &&
      isRecord(payload) &&
      typeof payload.text === "string" &&
      mode !== "delta"
    ) {
      mode = "assistant";
      const delta = stripComposerControlTokens(payload.text);
      if (delta) yield* emit(delta);
      continue;
    }

    if (event.event === "result" && isRecord(payload)) {
      const rawResult =
        typeof payload.result === "string"
          ? payload.result
          : typeof payload.text === "string"
            ? payload.text
            : "";
      const result = stripComposerControlTokens(rawResult);
      if (!text && result) {
        for (const emitted of emit(result)) yield emitted;
      }
      yield* recordAndYield(toolMarkers.flush());
      yield { type: "done", finalText: text, toolCalls };
      return;
    }

    if (event.event === "error" && isRecord(payload)) {
      const message =
        typeof payload.message === "string" ? payload.message : "Cursor stream failed";
      throw new HttpError(message, 502, "cursor_stream_error");
    }
  }
  yield* recordAndYield(toolMarkers.flush());
  yield { type: "done", finalText: text, toolCalls };
}

export async function collectTextEvents(
  stream: AsyncIterable<CursorTextEvent>,
): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  for await (const event of stream) {
    if (event.type === "text" && event.text) text += event.text;
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
    if (event.type === "done") {
      text = event.finalText;
      toolCalls = event.toolCalls;
    }
  }
  return { text, toolCalls };
}

export async function collectCursorOutput(
  response: Response,
): Promise<CursorCollectedOutput> {
  return collectTextEvents(streamCursorText(response));
}

export async function collectCursorText(response: Response): Promise<string> {
  return (await collectCursorOutput(response)).text;
}
