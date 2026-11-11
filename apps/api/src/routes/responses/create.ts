import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import {
  HttpError,
  isRecord,
  openAiErrorPayload,
  prepareResponsesRequest,
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { resolveRequestApiKey } from "../../utils/auth.js";
import { findOwnedResponse, resolveRequestPrincipal } from "../../utils/identity.js";
import { resolveSessionAffinity } from "../../utils/session.js";
import { sendHttpError } from "../../utils/error-handler.js";
import { createRequestCancellation } from "../../utils/request-cancellation.js";
import {
  getConfiguredDefaultWorkingDirectory,
  isHubIntegratedRequest,
  providerRequiresLocalWorkspace,
  resolveExecutionWorkingDirectory,
} from "../../utils/execution-working-directory.js";
import { resolveCursorExecutionModeForRequest } from "../../utils/cursor-execution-mode.js";
import { buildCursorExecutionContext } from "../../utils/cursor-execution-payload.js";
import {
  assertAntigravityToolsUnsupported,
  providerCredential,
  resolveProviderTarget,
} from "../../utils/provider-target.js";
import {
  executionImagesInput,
  resolveExecutionImages,
} from "../../utils/antigravity-images.js";
import {
  deliverNonStreamingResponse,
  extractActiveResponseToolResults,
  readReasoningEffort,
  readToolChoice,
  type ResponseDeliveryContext,
  streamResponseRun,
  toExecutorReasoningEffort,
} from "./delivery.js";

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

    const rawBody: unknown = req.body;
    const body = isRecord(rawBody) ? rawBody : {};
    const requestedModel = typeof body.model === "string" ? body.model : "composer-2.5";
    const target = resolveProviderTarget(requestedModel);
    const cursorModel =
      target.providerId === "cursor" ? { id: target.modelId } : undefined;

    const previousResponseId =
      typeof body.previous_response_id === "string"
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
      prepared = prepareResponsesRequest(rawBody, cursorModel, {
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

    const hubIntegrated = isHubIntegratedRequest(req);
    const cursorExecutionMode =
      target.providerId === "cursor"
        ? resolveCursorExecutionModeForRequest(req)
        : undefined;
    const workingDirectory = resolveExecutionWorkingDirectory({
      hubIntegrated,
      configuredDefault: getConfiguredDefaultWorkingDirectory(),
      toolContext: prepared.toolContext,
    });
    if (
      hubIntegrated &&
      providerRequiresLocalWorkspace(target.providerId) &&
      workingDirectory === undefined &&
      cursorExecutionMode === "local_runtime"
    ) {
      res
        .status(422)
        .json(
          openAiErrorPayload(
            "Agent workspace could not be resolved from the request. Include IDE working-directory context in instructions or input.",
            "invalid_request_error",
            "working_directory",
          ),
        );
      return;
    }

    const inputItems = Array.isArray(body.input) ? (body.input as unknown[]) : [];
    const toolResults = extractActiveResponseToolResults(inputItems);
    const reasoningEffort = readReasoningEffort(body);
    const executorReasoningEffort = toExecutorReasoningEffort(reasoningEffort);
    const toolChoice = readToolChoice(body.tool_choice);

    const providerStart = performance.now();
    const run = await services.executor.execute(target.providerId, {
      sessionId: sessionAffinity,
      model: target.modelId,
      message: prepared.prompt.text,
      credential: providerCredential(target, apiKey),
      signal: cancellation.signal,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ...(target.providerId === "cursor"
        ? { cursor: buildCursorExecutionContext(req, prepared) }
        : {}),
      ...(prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(typeof body.parallel_tool_calls === "boolean"
        ? { parallelToolCalls: body.parallel_tool_calls }
        : {}),
      ...(executorReasoningEffort !== undefined
        ? { reasoningEffort: executorReasoningEffort }
        : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
      ...executionImagesInput(images),
    });

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
      reasoningEffort,
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
