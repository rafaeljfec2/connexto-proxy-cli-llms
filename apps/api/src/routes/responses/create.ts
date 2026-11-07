import { collectRunText, confirmStreamingRunSuccess } from "../../utils/run.js";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import {
  doneChunk,
  HttpError,
  openAiErrorPayload,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseObject,
  responseTextStartEvents,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { resolveRequestApiKey } from "../../utils/auth.js";
import { findOwnedResponse, resolveRequestPrincipal } from "../../utils/identity.js";
import { resolveSessionAffinity } from "../../utils/session.js";
import { initSseHeaders } from "../../utils/sse.js";
import { getLogger } from "../../utils/logger.js";
import { sendHttpError } from "../../utils/error-handler.js";
import { createRequestCancellation } from "../../utils/request-cancellation.js";
import { resolveAgentWorkingDirectory } from "../../utils/working-directory.js";
import {
  assertAntigravityToolsUnsupported,
  providerCredential,
  resolveProviderTarget,
} from "../../utils/provider-target.js";
import {
  executionImagesInput,
  resolveExecutionImages,
} from "../../utils/antigravity-images.js";

export async function handleCreateResponse(req: Request, res: Response): Promise<void> {
  const services = getGatewayServices();
  const requestId =
    typeof res.locals.requestId === "string"
      ? res.locals.requestId
      : crypto.randomUUID();
  const cancellation = createRequestCancellation(req, res);
  let responseId: string | undefined;

  try {
    const principal = resolveRequestPrincipal(res.locals);
    if (principal === undefined) {
      res
        .status(401)
        .json(openAiErrorPayload("Missing or invalid gateway API key", "unauthorized"));
      return;
    }

    const body = req.body as Record<string, unknown>;
    const requestedModel =
      typeof body?.model === "string" ? body.model : "composer-2.5";
    const target = resolveProviderTarget(requestedModel);
    const cursorModel =
      target.providerId === "cursor" ? { id: target.modelId } : undefined;

    const previousResponseId =
      typeof body?.previous_response_id === "string"
        ? body.previous_response_id
        : undefined;

    // The previous Response must belong to the authenticated principal;
    // foreign and owner-less resources are indistinguishable from unknown.
    const previousState = previousResponseId
      ? findOwnedResponse(services.responseStore, previousResponseId, principal)
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
        sendHttpError(err, req, res);
        return;
      }
      res
        .status(400)
        .json(openAiErrorPayload("Invalid request payload", "invalid_request_error"));
      return;
    }

    assertAntigravityToolsUnsupported(target, prepared.tools.length);

    const apiKey =
      target.providerId === "cursor" ? resolveRequestApiKey(req) : undefined;
    if (target.providerId === "cursor" && apiKey === undefined) {
      res
        .status(401)
        .json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
      return;
    }
    const images = await resolveExecutionImages(
      target,
      prepared.prompt.images,
      cancellation.signal,
    );

    const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    responseId = id;
    const created = Math.floor(Date.now() / 1000);
    services.responseStore.pinActive(id);
    const sessionAffinity = resolveSessionAffinity(
      req,
      id,
      principal,
      previousState?.sdkSessionKey,
    );

    const providerStart = performance.now();
    const run = await services.executor.execute(target.providerId, {
      sessionId: sessionAffinity,
      model: target.modelId,
      message: prepared.prompt.text,
      credential: providerCredential(target, apiKey),
      signal: cancellation.signal,
      workingDirectory: resolveAgentWorkingDirectory(undefined, prepared.toolContext),
      ...executionImagesInput(images),
    });

    if (cancellation.signal.aborted) return;
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
      let firstDeltaMs: number | undefined;

      for await (const event of run.events) {
        if (cancellation.signal.aborted) break;
        if (event.type === "message.delta" && event.delta) {
          if (firstDeltaMs === undefined) {
            firstDeltaMs = Math.round((performance.now() - providerStart) * 100) / 100;
          }
          fullText += event.delta;
          res.write(responseDeltaEvent({ id, delta: event.delta, outputIndex: 0 }));
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
          ownerPrincipal: principal,
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
        ownerPrincipal: principal,
        responseData: resp,
      });
    }

    res.status(200).json(resp);
  } catch (error) {
    if (cancellation.signal.aborted || res.destroyed) return;
    sendHttpError(error, req, res);
  } finally {
    if (responseId !== undefined) {
      services.responseStore.unpinActive(responseId);
    }
    cancellation.dispose();
  }
}
