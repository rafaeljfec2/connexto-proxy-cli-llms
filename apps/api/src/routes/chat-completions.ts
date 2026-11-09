import {
  collectRunOutput,
  confirmStreamingRunSuccess,
} from "../utils/run.js";
import { openAiToolCallFromAgentEvent } from "../utils/agent-run-collect.js";
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
} from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../services/gateway.js";
import { resolveRequestApiKey } from "../utils/auth.js";
import { resolveRequestPrincipal } from "../utils/identity.js";
import { resolveSessionAffinity } from "../utils/session.js";
import { initSseHeaders } from "../utils/sse.js";
import { getLogger } from "../utils/logger.js";
import { sendHttpError } from "../utils/error-handler.js";
import { createRequestCancellation } from "../utils/request-cancellation.js";
import {
  assertAntigravityToolsUnsupported,
  providerCredential,
  resolveProviderTarget,
} from "../utils/provider-target.js";
import {
  executionImagesInput,
  resolveExecutionImages,
} from "../utils/antigravity-images.js";
import {
  getConfiguredDefaultWorkingDirectory,
  isHubIntegratedRequest,
  providerRequiresLocalWorkspace,
  resolveExecutionWorkingDirectory,
} from "../utils/execution-working-directory.js";
import { resolveCursorExecutionModeForRequest } from "../utils/cursor-execution-mode.js";
import { buildCursorExecutionContext } from "../utils/cursor-execution-payload.js";

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
        const target = resolveProviderTarget(requestedModel);
        const cursorModel =
          target.providerId === "cursor" ? { id: target.modelId } : undefined;

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

        assertAntigravityToolsUnsupported(target, prepared.tools.length);

        const apiKey =
          target.providerId === "cursor" ? resolveRequestApiKey(req) : undefined;

        const principal = resolveRequestPrincipal(res.locals);
        if (principal === undefined) {
          res
            .status(401)
            .json(
              openAiErrorPayload("Missing or invalid gateway API key", "unauthorized"),
            );
          return;
        }
        const credential = providerCredential(target, apiKey);
        const images = await resolveExecutionImages(
          target,
          prepared.prompt.images,
          cancellation.signal,
        );

        const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
        const created = Math.floor(Date.now() / 1000);
        const sessionAffinity = resolveSessionAffinity(req, id, principal);

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
          res.status(422).json(
            openAiErrorPayload(
              "Agent workspace could not be resolved from the request. Include IDE working-directory context in messages.",
              "invalid_request_error",
              "working_directory",
            ),
          );
          return;
        }

        const toolResults = extractActiveToolResults(
          Array.isArray(req.body?.messages) ? (req.body.messages as unknown[]) : [],
        );

        const services = getGatewayServices();
        const providerStart = performance.now();
        const run = await services.executor.execute(target.providerId, {
          sessionId: sessionAffinity,
          model: target.modelId,
          message: prepared.prompt.text,
          credential,
          signal: cancellation.signal,
          ...(workingDirectory !== undefined ? { workingDirectory } : {}),
          ...(target.providerId === "cursor"
            ? { cursor: buildCursorExecutionContext(req, prepared) }
            : {}),
          ...(prepared.tools.length > 0 ? { tools: prepared.tools } : {}),
          ...(req.body?.tool_choice !== undefined
            ? { toolChoice: req.body.tool_choice }
            : {}),
          ...(typeof req.body?.parallel_tool_calls === "boolean"
            ? { parallelToolCalls: req.body.parallel_tool_calls }
            : {}),
          ...(typeof req.body?.reasoning_effort === "string"
            ? { reasoningEffort: req.body.reasoning_effort }
            : {}),
          ...(toolResults.length > 0 ? { toolResults } : {}),
          ...executionImagesInput(images),
        });

        if (cancellation.signal.aborted) return;
        if (prepared.stream) {
          initSseHeaders(res);

          res.write(
            chatChunk({ id, created, model: prepared.model, role: "assistant" }),
          );

          let fullText = "";
          let firstDeltaMs: number | undefined;
          let toolCallIndex = 0;
          let streamFailed = false;

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
            } else if (event.type === "tool.call") {
              const toolCall = openAiToolCallFromAgentEvent(event);
              res.write(
                chatChunk({
                  id,
                  created,
                  model: prepared.model,
                  toolCall: { index: toolCallIndex, value: toolCall },
                }),
              );
              toolCallIndex += 1;
            } else if (event.type === "run.failed") {
              streamFailed = true;
              break;
            }
          }

          if (cancellation.signal.aborted) return;
          if (streamFailed || !(await confirmStreamingRunSuccess(run, target.providerId, res))) {
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

          res.write(
            chatChunk({
              id,
              created,
              model: prepared.model,
              finish: true,
              finishReason: toolCallIndex > 0 ? "tool_calls" : "stop",
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

        const runOutput = await collectRunOutput(run, res, cancellation.signal);
        const providerDurationMs =
          Math.round((performance.now() - providerStart) * 100) / 100;

        if (runOutput === null) {
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

        const response = chatCompletionResponse({
          id,
          created,
          model: prepared.model,
          text: runOutput.text,
          toolCalls: runOutput.toolCalls,
          promptChars: prepared.promptChars,
          usage: runOutput.usage,
          ...(target.providerId === "cursor"
            ? { metadata: { cursor_run_id: run.id } }
            : {}),
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

function extractActiveToolResults(
  messages: readonly unknown[],
): { toolCallId: string; toolName?: string; content: string }[] {
  let lastAssistantWithToolsIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m &&
      typeof m === "object" &&
      (m as Record<string, unknown>).role === "assistant" &&
      Array.isArray((m as Record<string, unknown>).tool_calls) &&
      ((m as Record<string, unknown>).tool_calls as unknown[]).length > 0
    ) {
      lastAssistantWithToolsIdx = i;
      break;
    }
  }

  const activeMessages =
    lastAssistantWithToolsIdx >= 0
      ? messages.slice(lastAssistantWithToolsIdx + 1)
      : messages;

  return activeMessages
    .filter(
      (m): m is Record<string, unknown> =>
        Boolean(m) &&
        typeof m === "object" &&
        (m as Record<string, unknown>).role === "tool",
    )
    .map((m) => ({
      toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
      toolName: typeof m.name === "string" ? m.name : undefined,
      content:
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? ""),
    }));
}
