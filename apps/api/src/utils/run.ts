import type { Response } from "express";
import type { AgentRun } from "@agent-runtime-gateway/core";
import { sendUpstreamFailure } from "./error-handler.js";
import { drainAgentRunEvents, type AgentRunOutput } from "./agent-run-collect.js";

export type { AgentRunOutput } from "./agent-run-collect.js";

export async function collectRunOutput(
  run: AgentRun,
  res?: Response,
  signal?: AbortSignal,
): Promise<AgentRunOutput | null> {
  const output = await drainAgentRunEvents(run, { signal });

  if (signal?.aborted) return null;
  const result = await run.wait();
  if (signal?.aborted) return null;

  if (output.sawFailure || result.status === "failed") {
    if (res) sendUpstreamFailure(res);
    return null;
  }
  if (result.status === "cancelled") {
    if (res) sendUpstreamFailure(res);
    return null;
  }

  if (!output.text && output.toolCalls.length === 0) {
    output.text = result.output?.text ?? "";
  }
  output.usage = result.usage;

  return output;
}

/** @deprecated Prefer {@link collectRunOutput} when tool calls matter. */
export async function collectRunText(
  run: AgentRun,
  res?: Response,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await collectRunOutput(run, res, signal);
  return output?.text ?? null;
}

export async function confirmStreamingRunSuccess(
  run: AgentRun,
  _providerId: string,
  res: Response,
): Promise<boolean> {
  const result = await run.wait();
  if (result.status === "completed") {
    return true;
  }
  sendUpstreamFailure(res);
  return false;
}
