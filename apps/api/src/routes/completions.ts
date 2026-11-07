import { collectRunText, confirmStreamingRunSuccess } from "../utils/run.js";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Express, Request, Response } from "express";
import {
  doneChunk,
  encodeSse,
  openAiErrorPayload,
  textCompletionResponse,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../services/gateway.js";
import { resolveRequestApiKey } from "../utils/auth.js";
import { initSseHeaders } from "../utils/sse.js";
import { getLogger } from "../utils/logger.js";
import { sendHttpError } from "../utils/error-handler.js";
import { createRequestCancellation } from "../utils/request-cancellation.js";
import { providerCredential, resolveProviderTarget } from "../utils/provider-target.js";
import { resolveCursorExecutionModeForRequest } from "../utils/cursor-execution-mode.js";

export function registerCompletionRoutes(app: Express): void {
  app.post("/v1/completions", async (req: Request, res: Response): Promise<void> => {
    const requestId =
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : crypto.randomUUID();
    const cancellation = createRequestCancellation(req, res);

    try {
      const body = req.body as { model?: unknown; prompt?: unknown; stream?: unknown };
      const requestedModel =
        typeof body?.model === "string" ? body.model : "composer-2.5";
      const target = resolveProviderTarget(requestedModel);

      let promptText = "";
      if (typeof body?.prompt === "string") {
        promptText = body.prompt;
      } else if (Array.isArray(body?.prompt)) {
        promptText = body.prompt.map(String).join("\n");
      } else {
        res
          .status(400)
          .json(
            openAiErrorPayload(
              "prompt must be a string or array of strings.",
              "invalid_request_error",
            ),
          );
        return;
      }

      const apiKey =
        target.providerId === "cursor" ? resolveRequestApiKey(req) : undefined;
      if (target.providerId === "cursor" && apiKey === undefined) {
        res
          .status(401)
          .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
        return;
      }

      const id = `cmpl_${crypto.randomUUID().replaceAll("-", "")}`;
      const created = Math.floor(Date.now() / 1000);
      const isStream = body?.stream === true;

      const services = getGatewayServices();
      const providerStart = performance.now();
      const cursorMode =
        target.providerId === "cursor"
          ? resolveCursorExecutionModeForRequest(req)
          : undefined;

      const run = await services.executor.execute(target.providerId, {
        sessionId: id,
        model: target.modelId,
        message: promptText,
        credential: providerCredential(target, apiKey),
        signal: cancellation.signal,
        ...(target.providerId === "cursor" && cursorMode !== undefined
          ? {
              cursor: {
                mode: cursorMode,
                promptMode: "ask" as const,
                requiresLocalTool: false,
              },
            }
          : {}),
      });

      if (cancellation.signal.aborted) return;
      if (isStream) {
        initSseHeaders(res);

        let firstDeltaMs: number | undefined;

        for await (const event of run.events) {
          if (cancellation.signal.aborted) break;
          if (event.type === "message.delta" && event.delta) {
            if (firstDeltaMs === undefined) {
              firstDeltaMs =
                Math.round((performance.now() - providerStart) * 100) / 100;
            }
            const chunk = {
              id,
              object: "text_completion",
              created,
              model: target.modelId,
              choices: [
                {
                  text: event.delta,
                  index: 0,
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            };
            res.write(encodeSse(chunk));
          }
        }

        if (cancellation.signal.aborted) return;
        if (!(await confirmStreamingRunSuccess(run, target.providerId, res))) {
          return;
        }
        const providerDurationMs =
          Math.round((performance.now() - providerStart) * 100) / 100;

        getLogger().info(
          {
            requestId,
            provider: target.providerId,
            model: target.modelId,
            status: "completed",
            durationMs: providerDurationMs,
            timeToFirstDeltaMs: firstDeltaMs ?? providerDurationMs,
          },
          "provider stream completed",
        );

        const finishChunk = {
          id,
          object: "text_completion",
          created,
          model: target.modelId,
          choices: [
            {
              text: "",
              index: 0,
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        };
        res.write(encodeSse(finishChunk));
        res.write(doneChunk());
        res.end();
        return;
      }

      const fullText = await collectRunText(run, res, cancellation.signal);
      const providerDurationMs =
        Math.round((performance.now() - providerStart) * 100) / 100;

      if (fullText === null) {
        if (cancellation.signal.aborted) return;
        getLogger().warn(
          {
            requestId,
            provider: target.providerId,
            model: target.modelId,
            status: "failed",
            durationMs: providerDurationMs,
          },
          "provider execution failed",
        );
        return;
      }

      getLogger().info(
        {
          requestId,
          provider: target.providerId,
          model: target.modelId,
          status: "completed",
          durationMs: providerDurationMs,
        },
        "provider execution completed",
      );

      res.status(200).json(
        textCompletionResponse({
          id,
          created,
          model: target.modelId,
          text: fullText,
          promptChars: promptText.length,
          cursorRunId: run.id,
        }),
      );
    } catch (error) {
      if (cancellation.signal.aborted || res.destroyed) return;
      sendHttpError(error, req, res);
    } finally {
      cancellation.dispose();
    }
  });
}
