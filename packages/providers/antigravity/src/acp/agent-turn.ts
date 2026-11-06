import type {
  NotificationListener,
  PromptContentBlock,
  PromptResult,
  SessionUpdateParams,
} from "./types.js";
import {
  JSON_RPC_ERROR_AUTH_REQUIRED,
  DEFAULT_PROMPT_TURN_TIMEOUT_MS,
} from "./constants.js";
import { AcpAuthRequiredError, AcpProtocolError, AcpTimeoutError } from "./errors.js";
import { SessionUpdateAccumulator } from "./session-updates.js";

export interface TurnTransport {
  readonly request: (
    method: string,
    params: unknown,
    timeoutMs: number,
  ) => Promise<{
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  }>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly onNotification: (listener: NotificationListener) => () => void;
}

export interface AgentTurnResult {
  readonly prompt: PromptResult;
  readonly agentText: string;
  readonly thoughtText: string;
}

export interface RunAgentTurnOptions {
  readonly timeoutMs?: number;
  /**
   * Receives every intermediate `session/update` of the turn's session as
   * `(kind, update)`; message/thought chunks additionally feed the final text.
   */
  readonly onEvent?: (kind: string, update: unknown) => void;
}

type TurnResponse = {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Executes one prompt turn: sends `session/prompt`, streams `session/update`
 * notifications for that session while the turn is in flight, and resolves
 * with the final `stopReason`, usage, and reconstructed agent text.
 */
export async function runAgentTurn(
  transport: TurnTransport,
  sessionId: string,
  prompt: readonly PromptContentBlock[],
  options: RunAgentTurnOptions = {},
): Promise<AgentTurnResult> {
  const accumulator = new SessionUpdateAccumulator(() => {});

  const unsubscribe = transport.onNotification((method, params) => {
    if (method !== "session/update") {
      return;
    }
    if (!isSessionUpdateParams(params, sessionId)) {
      return;
    }
    const candidate = params;
    const kind = kindOf(candidate);
    if (kind === undefined) {
      return;
    }
    options.onEvent?.(kind, candidate["update"]);
    accumulator.handle(candidate);
  });

  let response: TurnResponse;
  try {
    response = await transport.request(
      "session/prompt",
      { sessionId, prompt: [...prompt] },
      options.timeoutMs ?? DEFAULT_PROMPT_TURN_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof AcpTimeoutError) {
      try {
        transport.notify("session/cancel", { sessionId });
      } catch (cancellationError) {
        error.recordCancellationFailure(cancellationError);
      }
    }
    throw error;
  } finally {
    unsubscribe();
  }

  validateTurnResponse(response);

  const result = response.result as { stopReason?: unknown; usage?: unknown };
  return {
    prompt: {
      stopReason: result["stopReason"] as string,
      usage: result["usage"] as PromptResult["usage"],
    },
    agentText: accumulator.getAgentText(),
    thoughtText: accumulator.getThoughtText(),
  };
}

function validateTurnResponse(response: TurnResponse): void {
  if (response.error !== undefined) {
    if (response.error.code === JSON_RPC_ERROR_AUTH_REQUIRED) {
      throw new AcpAuthRequiredError(response.error.message);
    }
    throw new AcpProtocolError(
      response.error.message,
      response.error.code,
      response.error.data,
    );
  }
  const result = response.result as { stopReason?: unknown } | undefined;
  if (result === undefined || typeof result["stopReason"] !== "string") {
    throw new AcpProtocolError("session/prompt finished without a stopReason.", -32602);
  }
  void result;
}

function kindOf(params: SessionUpdateParams): string | undefined {
  const update = params["update"] as { sessionUpdate?: string } | undefined;
  return update?.sessionUpdate;
}

function isSessionUpdateParams(
  value: unknown,
  expectedSessionId: string,
): value is SessionUpdateParams {
  if (!isRecord(value) || value["sessionId"] !== expectedSessionId) {
    return false;
  }
  const update = value["update"];
  return isRecord(update) && typeof update["sessionUpdate"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
