import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  doneChunk,
  HttpError,
  openAiErrorPayload,
  prepareResponsesRequest,
  resolveCursorModel,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseObject,
  responseTextStartEvents,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../services/gateway.js";
import { resolveRequestApiKey } from "../utils/auth.js";

function getParamId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : (raw ?? "");
}

export function registerResponseRoutes(app: Express): void {
  const services = getGatewayServices();

  // 1. POST /v1/responses
  app.post("/v1/responses", async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const requestedModel =
        typeof body?.model === "string" ? body.model : "composer-2.5";
      const cursorModel = resolveCursorModel(requestedModel);

      const previousResponseId =
        typeof body?.previous_response_id === "string"
          ? body.previous_response_id
          : undefined;

      const previousState = previousResponseId
        ? services.responseStore.get(previousResponseId)
        : undefined;
      if (previousResponseId && !previousState) {
        res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
        return;
      }

      let prepared;
      try {
        prepared = prepareResponsesRequest(body, cursorModel, {
          previousOutput: previousState?.outputItems,
          previousInputItems: previousState?.inputItems,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res
            .status(err.status)
            .json(openAiErrorPayload(err.message, err.code, err.param));
          return;
        }
        res
          .status(400)
          .json(openAiErrorPayload("Invalid request payload", "invalid_request_error"));
        return;
      }

      const apiKey = resolveRequestApiKey(req);
      if (!apiKey) {
        res
          .status(401)
          .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
        return;
      }

      const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
      const created = Math.floor(Date.now() / 1000);
      const sessionAffinity =
        (req.headers["x-session-affinity"] as string | undefined) ??
        (req.headers["x-opencode-session"] as string | undefined) ??
        previousState?.sdkSessionKey ??
        id;

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

        for (const frame of responseCreatedEvents({
          id,
          created,
          model: prepared.model,
        })) {
          res.write(frame);
        }

        for (const frame of responseTextStartEvents({ id, outputIndex: 0 })) {
          res.write(frame);
        }

        let fullText = "";
        for await (const event of run.events) {
          if (event.type === "message.delta" && event.delta) {
            fullText += event.delta;
            res.write(responseDeltaEvent({ id, delta: event.delta, outputIndex: 0 }));
          }
        }

        for (const frame of responseDoneEvents({
          id,
          created,
          model: prepared.model,
          text: fullText,
          promptChars: prepared.promptChars,
          textStarted: true,
          textOutputIndex: 0,
        })) {
          res.write(frame);
        }

        res.write(doneChunk());
        res.end();

        if (prepared.storeResponse) {
          services.responseStore.set(id, {
            id,
            created,
            model: prepared.model,
            inputItems: prepared.responseInputItems ?? [],
            sdkSessionKey: sessionAffinity,
            responseData: responseObject({
              id,
              created,
              model: prepared.model,
              text: fullText,
              promptChars: prepared.promptChars,
            }),
          });
        }
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

      const resp = responseObject({
        id,
        created,
        model: prepared.model,
        text: fullText,
        promptChars: prepared.promptChars,
      });

      if (prepared.storeResponse) {
        services.responseStore.set(id, {
          id,
          created,
          model: prepared.model,
          inputItems: prepared.responseInputItems ?? [],
          sdkSessionKey: sessionAffinity,
          responseData: resp,
        });
      }

      res.status(200).json(resp);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      res.status(500).json(openAiErrorPayload(message, "internal_error"));
    }
  });

  // 2. POST /v1/responses/input_tokens
  app.post("/v1/responses/input_tokens", (req: Request, res: Response): void => {
    try {
      const body = req.body as Record<string, unknown>;
      const rawText = JSON.stringify(body?.input ?? "");
      const estimatedTokens = Math.max(0, Math.ceil(rawText.length / 4));
      res.status(200).json({
        object: "response.input_tokens",
        input_tokens: estimatedTokens,
      });
    } catch {
      res
        .status(400)
        .json(openAiErrorPayload("Invalid request", "invalid_request_error"));
    }
  });

  // 3. POST /v1/responses/compact
  app.post(
    "/v1/responses/compact",
    async (req: Request, res: Response): Promise<void> => {
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

        let compactedText = "";
        for await (const event of run.events) {
          if (event.type === "message.delta" && event.delta) {
            compactedText += event.delta;
          }
        }
        await run.wait();

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
    },
  );

  // 4. GET /v1/responses/:id
  app.get("/v1/responses/:id", (req: Request, res: Response): void => {
    const id = getParamId(req);
    const stored = services.responseStore.get(id);
    if (!stored || !stored.responseData) {
      res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
      return;
    }
    res.status(200).json(stored.responseData);
  });

  // 5. DELETE /v1/responses/:id
  app.delete("/v1/responses/:id", (req: Request, res: Response): void => {
    const id = getParamId(req);
    if (!services.responseStore.has(id)) {
      res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
      return;
    }
    services.responseStore.delete(id);
    res.status(200).json({
      id,
      object: "response",
      deleted: true,
    });
  });

  // 6. GET /v1/responses/:id/input_items
  app.get("/v1/responses/:id/input_items", (req: Request, res: Response): void => {
    const id = getParamId(req);
    const stored = services.responseStore.get(id);
    if (!stored) {
      res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
      return;
    }
    res.status(200).json({
      object: "list",
      data: stored.inputItems ?? [],
    });
  });

  // 7. POST /v1/responses/:id/cancel
  app.post("/v1/responses/:id/cancel", (req: Request, res: Response): void => {
    const id = getParamId(req);
    if (!services.responseStore.has(id)) {
      res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
      return;
    }
    res
      .status(400)
      .json(
        openAiErrorPayload(
          "Only background responses can be cancelled. Local responses run synchronously.",
          "invalid_request_error",
        ),
      );
  });
}
