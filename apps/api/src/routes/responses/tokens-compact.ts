import { collectRunText } from "../../utils/run.js";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import {
  openAiErrorPayload,
  resolveCursorModel,
  estimateTokens,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { resolveRequestApiKey } from "../../utils/auth.js";

export function handleInputTokens(req: Request, res: Response): void {
  try {
    const body = req.body as Record<string, unknown>;
    const rawText = JSON.stringify(body?.input ?? "");
    const estimatedTokens = estimateTokens(rawText.length);
    res.status(200).json({
      object: "response.input_tokens",
      input_tokens: estimatedTokens,
    });
  } catch {
    res
      .status(400)
      .json(openAiErrorPayload("Invalid request", "invalid_request_error"));
  }
}

export async function handleCompact(req: Request, res: Response): Promise<void> {
  const services = getGatewayServices();

  try {
    const body = req.body as Record<string, unknown>;
    const requestedModel =
      typeof body?.model === "string" ? body.model : "composer-2.5";
    const cursorModel = resolveCursorModel(requestedModel);

    const apiKey = resolveRequestApiKey(req);
    if (!apiKey) {
      res
        .status(401)
        .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
      return;
    }

    const rawInput = JSON.stringify(body?.input ?? "");
    const prompt = `Please summarize and compact the following conversational context while preserving all crucial information:\n${rawInput}`;

    const run = await services.executor.execute("cursor", {
      sessionId: `compact_${crypto.randomUUID().replaceAll("-", "")}`,
      model: cursorModel.id,
      message: prompt,
      credential: { type: "api_key", value: apiKey },
    });

    const compactedText = (await collectRunText(run, res)) ?? "";

    const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);

    res.status(200).json({
      id,
      object: "response.compaction",
      created,
      model: cursorModel.id,
      compacted_context: compactedText,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    res.status(500).json(openAiErrorPayload(message, "internal_error"));
  }
}
