import { collectRunText } from "../../utils/run.js";
import crypto from "node:crypto";
import type { Request, Response } from "express";
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
import { getGatewayServices } from "../../services/gateway.js";
import { resolveRequestApiKey } from "../../utils/auth.js";
import { resolveSessionAffinity } from "../../utils/session.js";
import { initSseHeaders } from "../../utils/sse.js";

export async function handleCreateResponse(req: Request, res: Response): Promise<void> {
  const services = getGatewayServices();

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
    const sessionAffinity = resolveSessionAffinity(
      req,
      id,
      previousState?.sdkSessionKey,
    );

    const run = await services.executor.execute("cursor", {
      sessionId: sessionAffinity,
      model: cursorModel.id,
      message: prepared.prompt.text,
      credential: { type: "api_key", value: apiKey },
    });

    if (prepared.stream) {
      initSseHeaders(res);

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

    const fullText = await collectRunText(run, res);
    if (fullText === null) return;

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
}
