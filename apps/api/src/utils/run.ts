import type { Response } from "express";
import type { AgentRun } from "@agent-runtime-gateway/core";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";

export async function collectRunText(
  run: AgentRun,
  res?: Response,
): Promise<string | null> {
  let fullText = "";
  for await (const event of run.events) {
    if (event.type === "message.delta" && event.delta) {
      fullText += event.delta;
    }
  }

  const result = await run.wait();
  if (result.status === "failed") {
    if (res) {
      res
        .status(502)
        .json(
          openAiErrorPayload(
            result.error?.message ?? "Execution failed",
            "upstream_error",
          ),
        );
    }
    return null;
  }

  return fullText;
}
