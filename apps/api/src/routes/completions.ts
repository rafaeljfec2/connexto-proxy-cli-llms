import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  doneChunk,
  encodeSse,
  openAiErrorPayload,
  resolveCursorModel,
  textCompletionResponse,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../services/gateway.js";
import { resolveRequestApiKey } from "../utils/auth.js";

export function registerCompletionRoutes(app: Express): void {
  app.post("/v1/completions", async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as { model?: unknown; prompt?: unknown; stream?: unknown };
      const requestedModel =
        typeof body?.model === "string" ? body.model : "composer-2.5";
      const cursorModel = resolveCursorModel(requestedModel);

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

      const apiKey = resolveRequestApiKey(req);
      if (!apiKey) {
        res
          .status(401)
          .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
        return;
      }

      const id = `cmpl_${crypto.randomUUID().replaceAll("-", "")}`;
      const created = Math.floor(Date.now() / 1000);
      const isStream = body?.stream === true;

      const services = getGatewayServices();
      const run = await services.executor.execute("cursor", {
        sessionId: id,
        model: cursorModel.id,
        message: promptText,
        credential: { type: "api_key", value: apiKey },
      });

      if (isStream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        for await (const event of run.events) {
          if (event.type === "message.delta" && event.delta) {
            const chunk = {
              id,
              object: "text_completion",
              created,
              model: cursorModel.id,
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

        const finishChunk = {
          id,
          object: "text_completion",
          created,
          model: cursorModel.id,
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

      res.status(200).json(
        textCompletionResponse({
          id,
          created,
          model: cursorModel.id,
          text: fullText,
          promptChars: promptText.length,
          cursorRunId: run.id,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      res.status(500).json(openAiErrorPayload(message, "internal_error"));
    }
  });
}
