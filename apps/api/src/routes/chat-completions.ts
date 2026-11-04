import crypto from "node:crypto";
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

export function registerChatCompletionRoutes(app: Express): void {
  app.post(
    "/v1/chat/completions",
    async (req: Request, res: Response): Promise<void> => {
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
            res
              .status(err.status)
              .json(openAiErrorPayload(err.message, err.code, err.param));
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
        const sessionAffinity =
          (req.headers["x-session-affinity"] as string | undefined) ??
          (req.headers["x-opencode-session"] as string | undefined) ??
          id;

        const services = getGatewayServices();
        const run = await services.executor.execute("cursor", {
          sessionId: sessionAffinity,
          model: cursorModel.id,
          message: prepared.prompt.text,
          credential: { type: "api_key", value: apiKey },
        });

        if (prepared.stream) {
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");

          res.write(
            chatChunk({ id, created, model: prepared.model, role: "assistant" }),
          );

          let fullText = "";
          for await (const event of run.events) {
            if (event.type === "message.delta" && event.delta) {
              fullText += event.delta;
              res.write(
                chatChunk({ id, created, model: prepared.model, delta: event.delta }),
              );
            }
          }

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

        let fullText = "";
        for await (const event of run.events) {
          if (event.type === "message.delta" && event.delta) {
            fullText += event.delta;
          }
        }

        const result = await run.wait();
        if (result.status === "failed") {
          res
            .status(502)
            .json(
              openAiErrorPayload(
                result.error?.message ?? "Execution failed",
                "upstream_error",
              ),
            );
          return;
        }

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
        const message = error instanceof Error ? error.message : "Internal error";
        res.status(500).json(openAiErrorPayload(message, "internal_error"));
      }
    },
  );
}
