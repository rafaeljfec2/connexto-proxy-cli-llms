import type {
  AgentExecutionInput,
  AgentProvider,
  AgentResult,
  AgentRun,
  Model,
} from "@agent-runtime-gateway/core";
import type { Run, SDKAgent } from "@cursor/sdk";
import { CursorClient } from "./client.js";
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
import { CursorSessionManager } from "./sessions.js";

function throwNormalized(error: unknown): never {
  const normalized = normalizeCursorError(error);
  throw new CursorProviderError(normalized.message, normalized.code, {
    retryable: normalized.retryable,
    cause: normalized.cause,
  });
}

export interface CursorProviderOptions {
  client?: CursorClient;
  sessions?: CursorSessionManager;
  agentName?: string;
  defaultWorkingDirectory?: string;
  /** Used by listModels when the gateway has not wired per-request credentials yet */
  listingCredential?: () => string | undefined;
}

export class CursorProvider implements AgentProvider {
  readonly id = "cursor";

  private readonly client: CursorClient;
  private readonly sessions: CursorSessionManager;
  private readonly agentName: string;
  private readonly defaultWorkingDirectory: string;
  private readonly listingCredential: () => string | undefined;

  constructor(options: CursorProviderOptions = {}) {
    this.client = options.client ?? new CursorClient();
    this.sessions =
      options.sessions ?? new CursorSessionManager(this.client, { maxSessions: 128 });
    this.agentName = options.agentName ?? "agent-runtime-gateway";
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.listingCredential =
      options.listingCredential ?? (() => process.env.CURSOR_API_KEY);
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
    const apiKey = resolveCursorApiKey(input.credential);
    const workingDirectory = input.workingDirectory ?? this.defaultWorkingDirectory;

    let agent: SDKAgent;
    try {
      agent = await this.sessions.acquireAgent(input.sessionId, {
        apiKey,
        model: input.model,
        name: this.agentName,
        workingDirectory,
      });
    } catch (error) {
      throwNormalized(error);
    }

    let run: Run;
    try {
      run = await agent.send(input.message, {
        model: { id: input.model },
      });
    } catch (error) {
      throwNormalized(error);
    }

    return adaptCursorRun({
      providerId: this.id,
      sessionId: input.sessionId,
      model: input.model,
      run,
      signal: input.signal,
    });
  }
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
      }
    })();
    return resultPromise;
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      void run.cancel().catch(() => undefined);
    } else {
      signal.addEventListener(
        "abort",
        () => {
          void run.cancel().catch(() => undefined);
        },
        { once: true },
      );
    }
  }

  async function* events() {
    yield createRunStartedEvent({
      runId: run.id,
      providerId,
      sessionId,
      model,
    });

    try {
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
    }
  }

  return {
    id: run.id,
    events: events(),
    wait: resolveResult,
    cancel: async (): Promise<void> => {
      try {
        await run.cancel();
      } catch {
        // Run may already be terminal.
      }
    },
  };
}
