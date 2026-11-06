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
  ListSessionsResult,
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
  listSessions(): Promise<ListSessionsResult>;
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
  closeSession(sessionId: string): Promise<void>;
  terminate(): Promise<void>;
}

/** Populated in POST /v1/runtime/sessions/clear when namespace is antigravity. */
export interface AntigravityRuntimeSessionClearReport {
  readonly mapped_acp_ids_count: number;
  readonly listed_acp_sessions_count: number;
  readonly acp_sessions_closed: number;
  readonly acp_close_failures: number;
  readonly warnings: readonly string[];
}

const ACP_CONNECT_TIMEOUT_MS = 20_000;
const ACP_LIST_SESSIONS_TIMEOUT_MS = 15_000;
const ACP_CLOSE_SESSION_TIMEOUT_MS = 15_000;

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

  /**
   * Step 1 of runtime clear: close ACP sessions upstream — first by persisted
   * gateway→ACP map, then by `session/list` and `session/close` for anything
   * still live in the local runtime. Returns a verifiable report.
   */
  public async closePersistedAcpSessions(): Promise<AntigravityRuntimeSessionClearReport> {
    let mappedIds: string[];
    try {
      mappedIds = await this.sessions.listAllAcpSessionIds();
    } catch {
      mappedIds = [];
    }
    return closeAntigravityAcpSessionsWithReport(
      mappedIds,
      this.defaultWorkingDirectory,
      this.clientFactory,
    );
  }

  /**
   * Step 2 of runtime clear: drop in-memory gateway→ACP maps and execution locks
   * after `sessionStore.clear("antigravity")` removed JSON on disk.
   */
  public clearSessionCaches(): void {
    this.sessions.clearInMemory();
    this.activeSessions.clear();
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function safeTerminate(client: AntigravityAcpClient): Promise<void> {
  try {
    await client.terminate();
  } catch {
    // ignore
  }
}

async function closeAntigravityAcpSessionsWithReport(
  mappedAcpSessionIds: readonly string[],
  defaultWorkingDirectory: string,
  clientFactory: (cwd: string) => AntigravityAcpClient,
): Promise<AntigravityRuntimeSessionClearReport> {
  const cwd = resolveWorkingDirectory(undefined, defaultWorkingDirectory);
  const warnings: string[] = [];
  const closedIds = new Set<string>();
  let closeFailures = 0;

  const dedupedMapped = [
    ...new Set(
      mappedAcpSessionIds.map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ];

  const mapClient = clientFactory(cwd);
  try {
    await withTimeout(mapClient.connect(), ACP_CONNECT_TIMEOUT_MS, "connect");
    for (const sessionId of dedupedMapped) {
      try {
        await withTimeout(
          mapClient.closeSession(sessionId),
          ACP_CLOSE_SESSION_TIMEOUT_MS,
          "closeSession",
        );
        closedIds.add(sessionId);
      } catch (error) {
        closeFailures += 1;
        warnings.push(
          `mapped close failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    warnings.push(
      `connect for mapped closes failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    closeFailures += dedupedMapped.length;
  } finally {
    await safeTerminate(mapClient);
  }

  const listClient = clientFactory(cwd);
  let listedCount = 0;
  try {
    await withTimeout(listClient.connect(), ACP_CONNECT_TIMEOUT_MS, "connect");
  } catch (error) {
    warnings.push(
      `connect for session/list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await safeTerminate(listClient);
    return {
      mapped_acp_ids_count: dedupedMapped.length,
      listed_acp_sessions_count: 0,
      acp_sessions_closed: closedIds.size,
      acp_close_failures: closeFailures,
      warnings,
    };
  }

  let listed: ListSessionsResult;
  try {
    listed = await withTimeout(
      listClient.listSessions(),
      ACP_LIST_SESSIONS_TIMEOUT_MS,
      "listSessions",
    );
  } catch (error) {
    warnings.push(
      `listSessions failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    listed = { sessions: [] };
  }

  const fromList = [
    ...new Set(
      listed.sessions
        .map((s) => (typeof s.sessionId === "string" ? s.sessionId.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  ];
  listedCount = fromList.length;

  for (const sessionId of fromList) {
    if (closedIds.has(sessionId)) {
      continue;
    }
    try {
      await withTimeout(
        listClient.closeSession(sessionId),
        ACP_CLOSE_SESSION_TIMEOUT_MS,
        "closeSession",
      );
      closedIds.add(sessionId);
    } catch (error) {
      closeFailures += 1;
      warnings.push(
        `listed close failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await safeTerminate(listClient);

  return {
    mapped_acp_ids_count: dedupedMapped.length,
    listed_acp_sessions_count: listedCount,
    acp_sessions_closed: closedIds.size,
    acp_close_failures: closeFailures,
    warnings,
  };
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
