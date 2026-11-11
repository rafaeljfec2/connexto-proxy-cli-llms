import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import {
  isRecord,
  openAiErrorPayload,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { resolveExecutionImages } from "../../utils/antigravity-images.js";
import { sendHttpError } from "../../utils/error-handler.js";
import { resolveRequestPrincipal } from "../../utils/identity.js";
import { createRequestCancellation } from "../../utils/request-cancellation.js";
import { resolveSessionAffinity } from "../../utils/session.js";
import {
  deliverNonStreamingResponse,
  readReasoningEffort,
  type ResponseDeliveryContext,
  streamResponseRun,
} from "./delivery.js";
import {
  buildAgentExecutionInput,
  resolveValidatedResponsesRequest,
  resolveWorkingDirectoryOrReject,
} from "./prepare-execution.js";

/** Express handler for OpenAI-compatible `POST /v1/responses`. */
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

    const validated = resolveValidatedResponsesRequest(req, res, services, principal);
    if (!validated) return;

    const { body, target, prepared, apiKey, previousSdkSessionKey } = validated;
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
      previousSdkSessionKey,
    );

    const workspaceCheck = resolveWorkingDirectoryOrReject(req, res, target, prepared);
    if (!workspaceCheck.ok) return;

    const providerStart = performance.now();
    const executionInput = buildAgentExecutionInput({
      req,
      body,
      sessionId: sessionAffinity,
      target,
      prepared,
      apiKey,
      signal: cancellation.signal,
      workingDirectory: workspaceCheck.workingDirectory,
      images,
    });
    const run = await services.executor.execute(target.providerId, executionInput);

    if (cancellation.signal.aborted) return;

    const deliveryContext: ResponseDeliveryContext = {
      id,
      created,
      requestId,
      principal,
      sessionAffinity,
      target,
      prepared,
      providerStart,
      services,
      signal: cancellation.signal,
      textFormat: isRecord(body.text) ? body.text.format : undefined,
      reasoningEffort: readReasoningEffort(body),
    };

    if (prepared.stream) {
      await streamResponseRun(run, res, deliveryContext);
      return;
    }

    await deliverNonStreamingResponse(run, res, deliveryContext);
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
