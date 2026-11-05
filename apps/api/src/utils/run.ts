import type { Response } from "express";
import type { AgentRun } from "@agent-runtime-gateway/core";
import { sendUpstreamFailure } from "./error-handler.js";

export async function collectRunText(
  run: AgentRun,
  res?: Response,
  signal?: AbortSignal,
): Promise<string | null> {
  let fullText = "";
  for await (const event of run.events) {
    if (signal?.aborted) return null;
    if (event.type === "message.delta" && event.delta) {
      fullText += event.delta;
    }
  }

  if (signal?.aborted) return null;
  const result = await run.wait();
  if (signal?.aborted) return null;
  if (result.status === "cancelled") {
    if (res) sendUpstreamFailure(res);
    return null;
  }
  if (result.status === "failed") {
    if (res) {
      sendUpstreamFailure(res);
    }
    return null;
  }

  return fullText;
}
