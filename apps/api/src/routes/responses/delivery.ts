import { performance } from "node:perf_hooks";
import type { Response } from "express";
import type {
  AgentReasoningEffort,
  AgentRun,
  AgentToolChoice,
} from "@agent-runtime-gateway/core";
import {
  doneChunk,
  enforceStructuredOutputFormat,
  isRecord,
  type PreparedRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
} from "@agent-runtime-gateway/compatibility-openai";
import type { GatewayServices } from "../../services/gateway.js";
import { openAiToolCallFromAgentEvent } from "../../utils/agent-run-collect.js";
import { getLogger } from "../../utils/logger.js";
import type { ProviderExecutionTarget } from "../../utils/provider-target.js";
import { collectRunOutput, confirmStreamingRunSuccess } from "../../utils/run.js";
import { initSseHeaders } from "../../utils/sse.js";

export interface ResponseDeliveryContext {
  readonly id: string;
  readonly created: number;
  readonly requestId: string;
  readonly principal: string;
  readonly sessionAffinity: string;
  readonly target: ProviderExecutionTarget;
  readonly prepared: PreparedRequest;
  readonly providerStart: number;
  readonly services: GatewayServices;
  readonly signal: AbortSignal;
  readonly textFormat?: unknown;
  readonly reasoningEffort?: string;
}

/** Reads optional reasoning effort from OpenAI Responses request body fields. */
export function readReasoningEffort(body: Record<string, unknown>): string | undefined {
  const nestedEffort = isRecord(body.reasoning) ? body.reasoning.effort : undefined;
  const candidate = nestedEffort ?? body.reasoning_effort;
  return typeof candidate === "string" ? candidate : undefined;
}

/** Narrows reasoning effort string to the executor's supported union. */
export function toExecutorReasoningEffort(
  value: string | undefined,
): AgentReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/** Narrows OpenAI tool_choice payloads into the core AgentToolChoice union. */
export function readToolChoice(value: unknown): AgentToolChoice | undefined {
  if (value === "none" || value === "auto" || value === "required") {
    return value;
  }
  if (!isRecord(value) || value.type !== "function") {
    return undefined;
  }
  if (isRecord(value.function) && typeof value.function.name === "string") {
    return { type: "function", function: { name: value.function.name } };
  }
  if (typeof value.name === "string") {
    return { type: "function", function: { name: value.name } };
  }
  return undefined;
}

/** Extracts tool output items following the most recent function_call item. */
export function extractActiveResponseToolResults(
  inputItems: readonly unknown[],
): { toolCallId: string; content: string }[] {
  let lastFunctionCallIdx = -1;
  for (let i = inputItems.length - 1; i >= 0; i--) {
    const item = inputItems[i];
    if (isRecord(item) && item.type === "function_call") {
      lastFunctionCallIdx = i;
      break;
    }
  }

  const activeItems =
    lastFunctionCallIdx >= 0 ? inputItems.slice(lastFunctionCallIdx + 1) : inputItems;

  return activeItems
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "function_call_output",
    )
    .map((item) => ({
      toolCallId: typeof item.call_id === "string" ? item.call_id : "",
      content:
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? ""),
    }));
}

/** Streams an executed AgentRun as OpenAI Responses SSE frames and stores if requested. */
export async function streamResponseRun(
  run: AgentRun,
  res: Response,
  ctx: ResponseDeliveryContext,
): Promise<void> {
  initSseHeaders(res);

  for (const frame of responseCreatedEvents({
    id: ctx.id,
    created: ctx.created,
    model: ctx.prepared.model,
  })) {
    res.write(frame);
  }

  for (const frame of responseTextStartEvents({ id: ctx.id, outputIndex: 0 })) {
    res.write(frame);
  }

  let fullText = "";
  let firstDeltaMs: number | undefined;
  const toolCalls: ReturnType<typeof openAiToolCallFromAgentEvent>[] = [];
  let streamFailed = false;

  for await (const event of run.events) {
    if (ctx.signal.aborted) break;
    if (event.type === "message.delta" && event.delta) {
      if (firstDeltaMs === undefined) {
        firstDeltaMs = Math.round((performance.now() - ctx.providerStart) * 100) / 100;
      }
      fullText += event.delta;
      res.write(responseDeltaEvent({ id: ctx.id, delta: event.delta, outputIndex: 0 }));
    } else if (event.type === "tool.call") {
      const toolCall = openAiToolCallFromAgentEvent(event);
      toolCalls.push(toolCall);
      const outputIndex = toolCalls.length;
      for (const frame of responseToolCallEvents({
        id: ctx.id,
        toolCall,
        outputIndex,
      })) {
        res.write(frame);
      }
    } else if (event.type === "run.failed") {
      streamFailed = true;
      break;
    }
  }

  if (ctx.signal.aborted) return;
  if (
    streamFailed ||
    !(await confirmStreamingRunSuccess(run, ctx.target.providerId, res))
  ) {
    return;
  }

  const providerDurationMs =
    Math.round((performance.now() - ctx.providerStart) * 100) / 100;
  getLogger().info(
    {
      requestId: ctx.requestId,
      provider: ctx.target.providerId,
      model: ctx.target.modelId,
      status: "completed",
      durationMs: providerDurationMs,
      timeToFirstDeltaMs: firstDeltaMs ?? providerDurationMs,
    },
    "provider stream completed",
  );

  for (const frame of responseDoneEvents({
    id: ctx.id,
    created: ctx.created,
    model: ctx.prepared.model,
    text: fullText,
    toolCalls,
    promptChars: ctx.prepared.promptChars,
    textStarted: true,
    textOutputIndex: 0,
  })) {
    res.write(frame);
  }

  res.write(doneChunk());
  res.end();

  if (ctx.prepared.storeResponse) {
    ctx.services.responseStore.set(ctx.id, {
      id: ctx.id,
      created: ctx.created,
      model: ctx.prepared.model,
      inputItems: ctx.prepared.responseInputItems ?? [],
      sdkSessionKey: ctx.sessionAffinity,
      ownerPrincipal: ctx.principal,
      responseData: responseObject({
        id: ctx.id,
        created: ctx.created,
        model: ctx.prepared.model,
        text: fullText,
        toolCalls,
        promptChars: ctx.prepared.promptChars,
      }),
    });
  }
}

/** Collects a non-streaming AgentRun, enforces structured output, and replies JSON. */
export async function deliverNonStreamingResponse(
  run: AgentRun,
  res: Response,
  ctx: ResponseDeliveryContext,
): Promise<void> {
  const runOutput = await collectRunOutput(run, res, ctx.signal);
  const providerDurationMs =
    Math.round((performance.now() - ctx.providerStart) * 100) / 100;

  if (runOutput === null) {
    if (ctx.signal.aborted) return;
    getLogger().warn(
      {
        requestId: ctx.requestId,
        provider: ctx.target.providerId,
        model: ctx.target.modelId,
        status: "failed",
        durationMs: providerDurationMs,
      },
      "provider execution failed",
    );
    return;
  }

  getLogger().info(
    {
      requestId: ctx.requestId,
      provider: ctx.target.providerId,
      model: ctx.target.modelId,
      status: "completed",
      durationMs: providerDurationMs,
    },
    "provider execution completed",
  );

  const responseText =
    runOutput.toolCalls.length === 0
      ? enforceStructuredOutputFormat(runOutput.text, ctx.textFormat)
      : runOutput.text;

  const resp = responseObject({
    id: ctx.id,
    created: ctx.created,
    model: ctx.prepared.model,
    text: responseText,
    toolCalls: runOutput.toolCalls,
    promptChars: ctx.prepared.promptChars,
    usage: runOutput.usage,
    reasoningEffort: ctx.reasoningEffort,
  });

  if (ctx.prepared.storeResponse) {
    ctx.services.responseStore.set(ctx.id, {
      id: ctx.id,
      created: ctx.created,
      model: ctx.prepared.model,
      inputItems: ctx.prepared.responseInputItems ?? [],
      sdkSessionKey: ctx.sessionAffinity,
      ownerPrincipal: ctx.principal,
      responseData: resp,
    });
  }

  res.status(200).json(resp);
}
