import { collectRunText } from "../../utils/run.js";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import {
  HttpError,
  openAiErrorPayload,
  estimateTokens,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { resolveRequestApiKey } from "../../utils/auth.js";
import { sendHttpError } from "../../utils/error-handler.js";
import { createRequestCancellation } from "../../utils/request-cancellation.js";
import {
  providerCredential,
  resolveProviderTarget,
} from "../../utils/provider-target.js";

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
  const cancellation = createRequestCancellation(req, res);

  try {
    const body = req.body as Record<string, unknown>;
    const requestedModel =
      typeof body?.model === "string" ? body.model : "composer-2.5";
    const target = resolveProviderTarget(requestedModel);

    if (target.providerId === "antigravity" && typeof body["input"] !== "string") {
      throw new HttpError(
        "Structured compact input is not supported for Antigravity models yet.",
        400,
        "unsupported_parameter",
        "input",
      );
    }

    const apiKey =
      target.providerId === "cursor" ? resolveRequestApiKey(req) : undefined;
    if (target.providerId === "cursor" && apiKey === undefined) {
      res
        .status(401)
        .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
      return;
    }

    const rawInput = JSON.stringify(body?.input ?? "");
    const prompt = `Please summarize and compact the following conversational context while preserving all crucial information:\n${rawInput}`;

    const run = await services.executor.execute(target.providerId, {
      sessionId: `compact_${crypto.randomUUID().replaceAll("-", "")}`,
      model: target.modelId,
      message: prompt,
      credential: providerCredential(target, apiKey),
      signal: cancellation.signal,
    });

    if (cancellation.signal.aborted) return;
    const compactedText = await collectRunText(run, res, cancellation.signal);
    if (compactedText === null) return;

    const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);

    res.status(200).json({
      id,
      object: "response.compaction",
      created,
      model: target.modelId,
      compacted_context: compactedText,
    });
  } catch (error) {
    if (cancellation.signal.aborted || res.destroyed) return;
    sendHttpError(error, req, res);
  } finally {
    cancellation.dispose();
  }
}
