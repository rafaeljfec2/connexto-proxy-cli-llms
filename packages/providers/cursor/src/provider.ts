import type {
  AgentExecutionInput,
  AgentProvider,
  AgentResult,
  AgentRun,
  AgentEvent,
  Model,
  NamespacedSessionStore,
  SessionStore,
} from "@agent-runtime-gateway/core";
import type { Run, SDKAgent } from "@cursor/sdk";
import { CursorClient } from "./client.js";
import { defaultCursorDeps, defaultCursorEnv, verifyCursorApiKey } from "./cursor.js";
import type { CursorMe } from "@agent-runtime-gateway/compatibility-openai";
import { resolveCursorApiKey } from "./credential.js";
import { normalizeCursorError } from "./errors.js";
import {
  createRunCancelledEvent,
  createRunCompletedEvent,
  createRunFailedEvent,
  createRunStartedEvent,
  mapRunResultToAgentResult,
  mapSdkMessageToEvents,
} from "./events.js";
import { CursorProviderError } from "./provider-error.js";
import {
  CursorSessionManager,
  type CursorSessionManagerOptions,
  type CursorSessionRecord,
} from "./sessions.js";
import { agentRunFromCursorTextStream } from "./edge-run.js";
import {
  createCursorSdkInProcessCompletion,
  type CursorSdkInProcessInput,
} from "./sdk-inprocess-runner.js";
import type { CursorSdkCompletion } from "./sdk/types.js";
import { ConfigurationError } from "@cursor/sdk";
import { HttpError } from "@agent-runtime-gateway/compatibility-openai";

function throwNormalized(error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }
  if (error instanceof ConfigurationError) {
    throw error;
  }
  const normalized = normalizeCursorError(error);
  throw new CursorProviderError(normalized.message, normalized.code, {
    retryable: normalized.retryable,
    cause: normalized.cause,
  });
}

export interface CursorProviderOptions {
  client?: CursorClient;
  sessions?: CursorSessionManager;
  sessionOptions?: CursorSessionManagerOptions;
  sessionStore?:
    NamespacedSessionStore<CursorSessionRecord> | SessionStore<CursorSessionRecord>;
  agentName?: string;
  defaultWorkingDirectory?: string;
  /** Used by listModels when the gateway has not wired per-request credentials yet */
  listingCredential?: () => string | undefined;
  executionGuard?: {
    onExecutionStart?: (input: { sessionId: string }) => void;
    onExecutionEnd?: (input: { sessionId: string }) => void;
  };
  edgeOwnedRunner?: (input: CursorSdkInProcessInput) => Promise<CursorSdkCompletion>;
}

export class CursorProvider implements AgentProvider {
  readonly id = "cursor";

  private readonly client: CursorClient;
  private readonly sessions: CursorSessionManager;
  private readonly agentName: string;
  private readonly defaultWorkingDirectory: string;
  private readonly listingCredential: () => string | undefined;
  private readonly executionGuard: CursorProviderOptions["executionGuard"];
  private readonly edgeOwnedRunner: NonNullable<
    CursorProviderOptions["edgeOwnedRunner"]
  >;

  constructor(options: CursorProviderOptions = {}) {
    this.client = options.client ?? new CursorClient();
    this.sessions =
      options.sessions ??
      new CursorSessionManager(this.client, {
        ...(options.sessionOptions ?? { maxSessions: 128 }),
        store: options.sessionOptions?.store ?? options.sessionStore,
      });

    this.agentName = options.agentName ?? "agent-runtime-gateway";
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.listingCredential =
      options.listingCredential ?? (() => process.env.CURSOR_API_KEY);
    this.executionGuard = options.executionGuard;
    this.edgeOwnedRunner =
      options.edgeOwnedRunner ?? createCursorSdkInProcessCompletion;
  }

  getSessionManager(): CursorSessionManager {
    return this.sessions;
  }

  /**
   * Clears in-memory Cursor session cache after persistence was wiped
   * (e.g. POST /v1/runtime/sessions/clear for namespace cursor).
   */
  clearSessionCaches(): void {
    this.sessions.clearInMemorySessionCache();
  }

  async verifyApiKey(apiKey: string): Promise<CursorMe> {
    try {
      return await verifyCursorApiKey(defaultCursorEnv(), defaultCursorDeps, apiKey);
    } catch (error) {
      throwNormalized(error);
    }
  }

  async listModels(): Promise<Model[]> {
    const apiKey = this.listingCredential()?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new CursorProviderError(
        "Cursor API key is not configured for listModels",
        "cursor_configuration_error",
      );
    }

    try {
      return await this.client.listModels(apiKey);
    } catch (error) {
      throwNormalized(error);
    }
  }

  async execute(input: AgentExecutionInput): Promise<AgentRun> {
    input.signal?.throwIfAborted();
    const apiKey = resolveCursorApiKey(input.credential);
    if (input.cursor?.mode === "edge_owned") {
      return this.executeEdgeOwned(input, apiKey);
    }
    const workingDirectory = input.workingDirectory ?? this.defaultWorkingDirectory;

    this.executionGuard?.onExecutionStart?.({ sessionId: input.sessionId });
    let agent: SDKAgent;
    try {
      agent = await this.sessions.acquireAgent(input.sessionId, {
        apiKey,
        model: input.model,
        name: this.agentName,
        workingDirectory,
      });
    } catch (error) {
      this.executionGuard?.onExecutionEnd?.({ sessionId: input.sessionId });
      throwNormalized(error);
    }

    input.signal?.throwIfAborted();

    let run: Run;
    try {
      run = await agent.send(input.message, {
        model: { id: input.model },
      });
    } catch (error) {
      this.executionGuard?.onExecutionEnd?.({ sessionId: input.sessionId });
      throwNormalized(error);
    }

    return guardAgentRun(
      adaptCursorRun({
        providerId: this.id,
        sessionId: input.sessionId,
        model: input.model,
        run,
        signal: input.signal,
      }),
      () => {
        this.executionGuard?.onExecutionEnd?.({ sessionId: input.sessionId });
      },
    );
  }

  private async executeEdgeOwned(
    input: AgentExecutionInput,
    apiKey: string,
  ): Promise<AgentRun> {
    const cursorContext = input.cursor;
    this.executionGuard?.onExecutionStart?.({ sessionId: input.sessionId });
    let executionEnded = false;
    const endExecution = (): void => {
      if (executionEnded) return;
      executionEnded = true;
      this.executionGuard?.onExecutionEnd?.({ sessionId: input.sessionId });
    };

    try {
      const completion = await this.edgeOwnedRunner({
        apiKey,
        model: input.model,
        agentName: this.agentName,
        prompt: input.message,
        clientTools: cursorContext?.clientTools ?? [],
        ...(input.workingDirectory !== undefined
          ? { workingDirectory: input.workingDirectory }
          : {}),
        ...(input.images !== undefined ? { images: input.images } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });

      if (input.signal?.aborted) {
        await completion.cancel?.();
        input.signal.throwIfAborted();
      }

      const run = agentRunFromCursorTextStream({
        providerId: this.id,
        sessionId: input.sessionId,
        model: input.model,
        runId: completion.runId,
        stream: completion.stream,
        signal: input.signal,
        cancel: async () => {
          try {
            await completion.cancel?.();
          } finally {
            endExecution();
          }
        },
      });
      return guardAgentRun(run, endExecution);
    } catch (error) {
      endExecution();
      throwNormalized(error);
    }
  }
}

function guardAgentRun(run: AgentRun, onEnd: () => void): AgentRun {
  let ended = false;
  const endOnce = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };

  async function* wrappedEvents(): AsyncGenerator<AgentEvent> {
    try {
      for await (const event of run.events) {
        yield event;
      }
    } finally {
      endOnce();
    }
  }

  return {
    id: run.id,
    events: wrappedEvents(),
    wait: async () => {
      try {
        return await run.wait();
      } finally {
        endOnce();
      }
    },
    cancel: async () => {
      try {
        await run.cancel();
      } finally {
        endOnce();
      }
    },
  };
}

function adaptCursorRun(input: {
  providerId: string;
  sessionId: string;
  model: string;
  run: Run;
  signal?: AbortSignal;
}): AgentRun {
  const { run, providerId, sessionId, model, signal } = input;
  let resultPromise: Promise<AgentResult> | undefined;
  let cancellationPromise: Promise<void> | undefined;
  let terminal = false;
  let abortListener: (() => void) | undefined;

  const removeAbortListener = (): void => {
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  const cancelOnce = (): Promise<void> => {
    if (terminal || run.status !== "running") {
      removeAbortListener();
      return Promise.resolve();
    }

    cancellationPromise ??= (async () => {
      try {
        await run.cancel();
      } catch {
        // Run may already be terminal.
      } finally {
        removeAbortListener();
      }
    })();
    return cancellationPromise;
  };

  const resolveResult = (): Promise<AgentResult> => {
    resultPromise ??= (async () => {
      try {
        const result = await run.wait();
        return mapRunResultToAgentResult(result);
      } catch (error) {
        const normalized = normalizeCursorError(error);
        return {
          status: "failed",
          error: {
            message: normalized.message,
            code: normalized.code,
          },
        };
      } finally {
        terminal = true;
        removeAbortListener();
      }
    })();
    return resultPromise;
  };

  if (signal !== undefined) {
    abortListener = () => {
      void cancelOnce();
    };
    if (signal.aborted) void cancelOnce();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  async function* events() {
    try {
      yield createRunStartedEvent({
        runId: run.id,
        providerId,
        sessionId,
        model,
      });

      for await (const message of run.stream()) {
        for (const event of mapSdkMessageToEvents(message, run.id)) {
          yield event;
        }
      }

      const result = await resolveResult();
      if (result.status === "completed") {
        yield createRunCompletedEvent(run.id);
        return;
      }
      if (result.status === "cancelled") {
        yield createRunCancelledEvent(run.id);
        return;
      }

      yield createRunFailedEvent(
        run.id,
        result.error?.message ?? "Cursor run failed",
        result.error?.code,
      );
    } catch (error) {
      const normalized = normalizeCursorError(error);
      yield createRunFailedEvent(run.id, normalized.message, normalized.code);
    } finally {
      if (!terminal && cancellationPromise === undefined) {
        void cancelOnce();
      }
      removeAbortListener();
    }
  }

  return {
    id: run.id,
    events: events(),
    wait: resolveResult,
    cancel: cancelOnce,
  };
}
