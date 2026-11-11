import type { Request, Response } from "express";
import type { AgentExecutionInput } from "@agent-runtime-gateway/core";
import {
  HttpError,
  isRecord,
  openAiErrorPayload,
  type PreparedRequest,
  prepareResponsesRequest,
} from "@agent-runtime-gateway/compatibility-openai";
import type { GatewayServices } from "../../services/gateway.js";
import { executionImagesInput } from "../../utils/antigravity-images.js";
import { resolveRequestApiKey } from "../../utils/auth.js";
import { resolveCursorExecutionModeForRequest } from "../../utils/cursor-execution-mode.js";
import { buildCursorExecutionContext } from "../../utils/cursor-execution-payload.js";
import { sendHttpError } from "../../utils/error-handler.js";
import {
  getConfiguredDefaultWorkingDirectory,
  isHubIntegratedRequest,
  providerRequiresLocalWorkspace,
  resolveExecutionWorkingDirectory,
} from "../../utils/execution-working-directory.js";
import { findOwnedResponse } from "../../utils/identity.js";
import {
  assertAntigravityToolsUnsupported,
  providerCredential,
  type ProviderExecutionTarget,
  resolveProviderTarget,
} from "../../utils/provider-target.js";
import {
  extractActiveResponseToolResults,
  readReasoningEffort,
  readToolChoice,
  toExecutorReasoningEffort,
} from "./delivery.js";

export interface ValidatedResponsesRequest {
  readonly body: Record<string, unknown>;
  readonly target: ProviderExecutionTarget;
  readonly prepared: PreparedRequest;
  readonly apiKey: string | undefined;
  readonly previousSdkSessionKey: string | undefined;
}

/**
 * Validates model target, previous response ownership, request payload,
 * provider constraints, and Cursor API key; sends error response and returns
 * undefined when validation fails.
 */
export function resolveValidatedResponsesRequest(
  req: Request,
  res: Response,
  services: GatewayServices,
  principal: string,
): ValidatedResponsesRequest | undefined {
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
    return undefined;
  }

  let prepared: PreparedRequest;
  try {
    prepared = prepareResponsesRequest(rawBody, cursorModel, {
      previousOutput: previousState?.outputItems,
      previousInputItems: previousState?.inputItems,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      sendHttpError(err, req, res);
      return undefined;
    }
    res
      .status(400)
      .json(openAiErrorPayload("Invalid request payload", "invalid_request_error"));
    return undefined;
  }

  assertAntigravityToolsUnsupported(target, prepared.tools.length);

  const apiKey = target.providerId === "cursor" ? resolveRequestApiKey(req) : undefined;
  if (target.providerId === "cursor" && apiKey === undefined) {
    res.status(401).json(openAiErrorPayload("Missing Cursor API key", "unauthorized"));
    return undefined;
  }

  return {
    body,
    target,
    prepared,
    apiKey,
    previousSdkSessionKey: previousState?.sdkSessionKey,
  };
}

/**
 * Resolves the workspace directory when required by hub-integrated local execution,
 * returning HTTP 422 if it cannot be determined.
 */
export function resolveWorkingDirectoryOrReject(
  req: Request,
  res: Response,
  target: ProviderExecutionTarget,
  prepared: PreparedRequest,
): { readonly ok: true; readonly workingDirectory?: string } | { readonly ok: false } {
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
    return { ok: false };
  }

  return { ok: true, workingDirectory };
}

/** Builds the typed AgentExecutionInput for `services.executor.execute`. */
export function buildAgentExecutionInput(params: {
  readonly req: Request;
  readonly body: Record<string, unknown>;
  readonly sessionId: string;
  readonly target: ProviderExecutionTarget;
  readonly prepared: PreparedRequest;
  readonly apiKey: string | undefined;
  readonly signal: AbortSignal;
  readonly workingDirectory: string | undefined;
  readonly images: Parameters<typeof executionImagesInput>[0];
}): AgentExecutionInput {
  const { req, body, target, prepared } = params;
  const inputItems = Array.isArray(body.input) ? (body.input as unknown[]) : [];
  const toolResults = extractActiveResponseToolResults(inputItems);
  const executorReasoningEffort = toExecutorReasoningEffort(readReasoningEffort(body));
  const toolChoice = readToolChoice(body.tool_choice);

  return {
    sessionId: params.sessionId,
    model: target.modelId,
    message: prepared.prompt.text,
    credential: providerCredential(target, params.apiKey),
    signal: params.signal,
    ...(params.workingDirectory !== undefined
      ? { workingDirectory: params.workingDirectory }
      : {}),
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
    ...executionImagesInput(params.images),
  };
}

