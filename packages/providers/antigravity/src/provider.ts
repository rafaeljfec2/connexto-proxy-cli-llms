import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentExecutionInput,
  AgentProvider,
  AgentResult,
  AgentRun,
  Model,
  NamespacedSessionStore,
  SessionStore,
} from "@agent-runtime-gateway/core";
import {
  AcpClient,
  AcpTurnInProgressError,
  AGY_CLI_PATH_ENV,
  DEFAULT_AGY_BINARY,
  defaultAgyPathCandidates,
  textBlock,
} from "./acp/index.js";
import {
  DEFAULT_AUTH_METHOD_ID,
  DEFAULT_PROCESS_GRACE_MS,
  DEFAULT_PROMPT_TURN_TIMEOUT_MS,
} from "./acp/constants.js";
import type {
  AgentTurnResult,
  ContentBlock,
  RunAgentTurnOptions,
  SessionConfigOption,
} from "./acp/index.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import {
  createCancelledResult,
  createCompletedResult,
  createFailedResult,
  createRunStartedEvent,
  createTerminalEvent,
  mapAcpUpdateToEvent,
} from "./events.js";
import { acpModelId, ANTIGRAVITY_MODELS } from "./models.js";
import {
  AntigravitySessionStore,
  type AcpSessionRecord,
  type AntigravitySessionStoreOptions,
} from "./session-store.js";

export interface AntigravityAcpClient {
  connect(): Promise<void>;
  createSession(cwd: string, mcpServers?: unknown[]): Promise<{ sessionId: string }>;
  resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
  ): Promise<Record<string, unknown>>;
  setSessionConfig(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<readonly SessionConfigOption[]>;
  prompt(
    sessionId: string,
    blocks: readonly ContentBlock[],
    options?: RunAgentTurnOptions,
  ): Promise<AgentTurnResult>;
  cancelTurn(sessionId: string): void;
  terminate(): Promise<void>;
}

export interface AntigravityProviderOptions {
  readonly clientFactory?: (cwd: string) => AntigravityAcpClient;
  readonly defaultWorkingDirectory?: string;
  readonly cancelGraceMs?: number;
  readonly sessionOptions?: AntigravitySessionStoreOptions;
  readonly sessionStore?:
    NamespacedSessionStore<AcpSessionRecord> | SessionStore<AcpSessionRecord>;
}

const DEFAULT_CANCEL_GRACE_MS = 3_000;
const LOCAL_CREDENTIAL_TYPE = "local";
const DEFAULT_CLIENT_INFO = {
  name: "agent-runtime-gateway",
  version: "0.0.0",
} as const;

export class AntigravityProvider implements AgentProvider {
  public readonly id = "antigravity";

  private readonly clientFactory: (cwd: string) => AntigravityAcpClient;
  private readonly defaultWorkingDirectory: string;
  private readonly cancelGraceMs: number;
  private readonly sessions: AntigravitySessionStore;
  private readonly activeSessions = new Set<string>();

  constructor(options: AntigravityProviderOptions = {}) {
    this.clientFactory = options.clientFactory ?? createDefaultClient;
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.sessions = new AntigravitySessionStore({
      ...options.sessionOptions,
      store: options.sessionOptions?.store ?? options.sessionStore,
    });
  }

  public listModels(): Promise<Model[]> {
    return Promise.resolve(ANTIGRAVITY_MODELS.map((model) => ({ ...model })));
  }

  public async execute(input: AgentExecutionInput): Promise<AgentRun> {
    const acpModel = acpModelId(input.model);
    if (acpModel === undefined) {
      throw new Error("Antigravity provider received an unsupported model.");
    }
    if (input.credential.type !== LOCAL_CREDENTIAL_TYPE) {
      throw new Error("Antigravity provider requires local ACP authentication.");
    }
    input.signal?.throwIfAborted();
    if (this.activeSessions.has(input.sessionId)) {
      throw new AcpTurnInProgressError();
    }
    const cwd = resolveWorkingDirectory(
      input.workingDirectory,
      this.defaultWorkingDirectory,
    );
    const client = this.clientFactory(cwd);
    this.activeSessions.add(input.sessionId);
    let acpSessionId: string;
    try {
      await client.connect();
      acpSessionId = await this.acquireAcpSession(client, input.sessionId, cwd);
      await client.setSessionConfig(acpSessionId, "model", acpModel);
      input.signal?.throwIfAborted();
    } catch (error) {
      this.activeSessions.delete(input.sessionId);
      await terminatePreservingCause(client, error);
      throw error;
    }

    return this.createRun(client, input, acpSessionId);
  }

  private async acquireAcpSession(
    client: AntigravityAcpClient,
    gatewaySessionId: string,
    cwd: string,
  ): Promise<string> {
    const savedSessionId = await this.sessions.resolve(gatewaySessionId);
    if (savedSessionId !== undefined) {
      try {
        await client.resumeSession(savedSessionId, cwd);
        return savedSessionId;
      } catch {
        // Resume failures fall back to a new ACP session, as Cursor does.
        await this.sessions.delete(gatewaySessionId);
      }
    }

    const created = await client.createSession(cwd);
    await this.sessions.setPersisted(gatewaySessionId, created.sessionId);
    return created.sessionId;
  }

  private createRun(
    client: AntigravityAcpClient,
    input: AgentExecutionInput,
    acpSessionId: string,
  ): AgentRun {
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const queue = new AsyncEventQueue();
    const startedEvent = createRunStartedEvent({
      runId,
      sessionId: input.sessionId,
      model: input.model,
    });
    queue.push(startedEvent);

    let cancelRequested = false;
    let cancellationFailure: unknown;
    let cancellationPromise: Promise<void> | undefined;
    const abortListener = (): void => {
      void requestCancellation().catch((error: unknown) => {
        cancellationFailure = error;
      });
    };
    const resultPromise = this.runTurn(
      client,
      input,
      acpSessionId,
      runId,
      queue,
      () => cancelRequested,
      () => cancellationFailure,
      abortListener,
    );
    const cancelAndStop = async (): Promise<void> => {
      try {
        client.cancelTurn(acpSessionId);
      } catch (error) {
        cancellationFailure = error;
        try {
          await client.terminate();
        } catch (cleanupError) {
          cancellationFailure = new AggregateError(
            [error, cleanupError],
            "ACP cancellation and process cleanup both failed.",
          );
        }
      }

      const completed = await waitForCompletion(resultPromise, this.cancelGraceMs);
      if (!completed) {
        try {
          await client.terminate();
        } catch (error) {
          cancellationFailure ??= error;
        }
      }
      try {
        await resultPromise;
      } catch (error) {
        cancellationFailure ??= error;
      }
    };
    const requestCancellation = (): Promise<void> => {
      cancelRequested = true;
      cancellationPromise ??= cancelAndStop();
      return cancellationPromise;
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });
    if (input.signal?.aborted === true) {
      abortListener();
    }

    return {
      id: runId,
      events: queue,
      wait: () => resultPromise ?? Promise.resolve(createCancelledResult()),
      cancel: () => requestCancellation(),
    };
  }

  private async runTurn(
    client: AntigravityAcpClient,
    input: AgentExecutionInput,
    acpSessionId: string,
    runId: string,
    queue: AsyncEventQueue,
    isCancelRequested: () => boolean,
    getCancellationFailure: () => unknown,
    abortListener: () => void,
  ): Promise<AgentResult> {
    let result: AgentResult;
    try {
      const turn = await client.prompt(acpSessionId, [textBlock(input.message)], {
        timeoutMs: DEFAULT_PROMPT_TURN_TIMEOUT_MS,
        onEvent: (kind, update) => {
          const event = mapAcpUpdateToEvent(runId, kind, update);
          if (event !== undefined) {
            queue.push(event);
          }
        },
      });
      result = isCancelResult(turn, isCancelRequested())
        ? createCancelledResult()
        : createCompletedResult(turn.agentText);
    } catch {
      result = isCancelRequested() ? createCancelledResult() : createFailedResult();
    }

    if (getCancellationFailure() !== undefined) {
      result = createFailedResult();
    }

    let cleanupFailure: unknown;
    try {
      await client.terminate();
    } catch (error) {
      cleanupFailure = error;
      result = createFailedResult();
    } finally {
      input.signal?.removeEventListener("abort", abortListener);
      this.activeSessions.delete(input.sessionId);
    }

    queue.push(createTerminalEvent(result, runId));
    queue.close();
    if (cleanupFailure !== undefined) {
      throw cleanupError(cleanupFailure);
    }
    return result;
  }
}

function createDefaultClient(cwd: string): AntigravityAcpClient {
  return new AcpClient({
    command: resolveAgyCommand(),
    cwd,
    clientInfo: DEFAULT_CLIENT_INFO,
    authMethodId: DEFAULT_AUTH_METHOD_ID,
    timeouts: { processGraceMs: DEFAULT_PROCESS_GRACE_MS },
  });
}

function resolveAgyCommand(): string {
  const configuredPath = process.env[AGY_CLI_PATH_ENV]?.trim();
  if (configuredPath) {
    return configuredPath;
  }
  const homeBinary = defaultAgyPathCandidates().find((candidate) =>
    fs.existsSync(candidate),
  );
  return homeBinary ?? DEFAULT_AGY_BINARY;
}

function resolveWorkingDirectory(
  requestedDirectory: string | undefined,
  defaultDirectory: string,
): string {
  const candidate = requestedDirectory?.trim() || defaultDirectory;
  return path.resolve(candidate);
}

async function terminatePreservingCause(
  client: AntigravityAcpClient,
  cause: unknown,
): Promise<void> {
  try {
    await client.terminate();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      "Antigravity setup and ACP process cleanup failed.",
    );
  }
}

function isCancelResult(turn: AgentTurnResult, cancelRequested: boolean): boolean {
  return cancelRequested || turn.prompt.stopReason === "cancelled";
}

function cleanupError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("ACP process cleanup failed.", { cause: error });
}

async function waitForCompletion(
  result: Promise<AgentResult>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = await Promise.race([
    result.then(
      () => true,
      () => true,
    ),
    timeout,
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return completed;
}
