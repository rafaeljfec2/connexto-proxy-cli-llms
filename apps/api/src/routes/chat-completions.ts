import { collectRunText } from "../utils/run.js";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Express, Request, Response } from "express";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  doneChunk,
  HttpError,
  openAiErrorPayload,
  prepareChatRequest,
  resolveCursorModel,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../services/gateway.js";
import { resolveRequestApiKey } from "../utils/auth.js";
import { resolveSessionAffinity } from "../utils/session.js";
import { initSseHeaders } from "../utils/sse.js";
import { getLogger } from "../utils/logger.js";
import { sendHttpError } from "../utils/error-handler.js";
import { createRequestCancellation } from "../utils/request-cancellation.js";

export function registerChatCompletionRoutes(app: Express): void {
  app.post(
    "/v1/chat/completions",
    async (req: Request, res: Response): Promise<void> => {
      const requestId =
        typeof res.locals.requestId === "string"
          ? res.locals.requestId
          : crypto.randomUUID();
      const cancellation = createRequestCancellation(req, res);

      try {
        const body = req.body as {
          model?: unknown;
          messages?: unknown;
          stream?: unknown;
        };
        const requestedModel =
          typeof body?.model === "string" ? body.model : "composer-2.5";
        const cursorModel = resolveCursorModel(requestedModel);

        let prepared;
        try {
          prepared = prepareChatRequest(body, cursorModel);
        } catch (err) {
          if (err instanceof HttpError) {
            sendHttpError(err, req, res);
            return;
          }
          res
            .status(400)
            .json(
              openAiErrorPayload("Invalid request payload", "invalid_request_error"),
            );
          return;
        }

        const apiKey = resolveRequestApiKey(req);
        if (!apiKey) {
          res
            .status(401)
            .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
          return;
        }

        const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
        const created = Math.floor(Date.now() / 1000);
        const sessionAffinity = resolveSessionAffinity(req, id);

        const services = getGatewayServices();
        const providerStart = performance.now();
        const run = await services.executor.execute("cursor", {
          sessionId: sessionAffinity,
          model: cursorModel.id,
          message: prepared.prompt.text,
          credential: { type: "api_key", value: apiKey },
          signal: cancellation.signal,
        });

        if (cancellation.signal.aborted) return;
        if (prepared.stream) {
          initSseHeaders(res);

          res.write(
            chatChunk({ id, created, model: prepared.model, role: "assistant" }),
          );

          let fullText = "";
          let firstDeltaMs: number | undefined;

          for await (const event of run.events) {
            if (cancellation.signal.aborted) break;
            if (event.type === "message.delta" && event.delta) {
              if (firstDeltaMs === undefined) {
                firstDeltaMs =
                  Math.round((performance.now() - providerStart) * 100) / 100;
              }
              fullText += event.delta;
              res.write(
                chatChunk({ id, created, model: prepared.model, delta: event.delta }),
              );
            }
          }

          if (cancellation.signal.aborted) return;
          const providerDurationMs =
            Math.round((performance.now() - providerStart) * 100) / 100;

          getLogger().info(
            {
              requestId,
              provider: "cursor",
              model: cursorModel.id,
              status: "completed",
              durationMs: providerDurationMs,
              timeToFirstDeltaMs: firstDeltaMs ?? providerDurationMs,
            },
            "provider stream completed",
          );

          res.write(
            chatChunk({
              id,
              created,
              model: prepared.model,
              finish: true,
              finishReason: "stop",
            }),
          );

          if (prepared.includeUsage) {
            res.write(
              chatUsageChunk({
                id,
                created,
                model: prepared.model,
                promptChars: prepared.promptChars,
                completionChars: fullText.length,
              }),
            );
          }

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
              provider: "cursor",
              model: cursorModel.id,
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
            provider: "cursor",
            model: cursorModel.id,
            status: "completed",
            durationMs: providerDurationMs,
          },
          "provider execution completed",
        );

        const response = chatCompletionResponse({
          id,
          created,
          model: prepared.model,
          text: fullText,
          promptChars: prepared.promptChars,
          metadata: {
            cursor_run_id: run.id,
          },
        });

        res.status(200).json(response);
      } catch (error) {
        if (cancellation.signal.aborted || res.destroyed) return;
        sendHttpError(error, req, res);
      } finally {
        cancellation.dispose();
      }
    },
  );
}
