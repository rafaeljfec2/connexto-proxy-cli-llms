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
  imageBlock,
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
import { AntigravityMcpBridge } from "./mcp/index.js";

export interface AntigravityAcpClient {
  connect(): Promise<void>;
  authenticate?(methodId?: string): Promise<void>;
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

const ACP_CONNECT_TIMEOUT_MS = 3_000;
const ACP_LIST_SESSIONS_TIMEOUT_MS = 2_000;
const ACP_CLOSE_SESSION_TIMEOUT_MS = 2_000;

import { PendingToolRegistry } from "./pending-tools.js";

export interface AntigravityProviderOptions {
  readonly clientFactory?: (cwd: string) => AntigravityAcpClient;
  readonly defaultWorkingDirectory?: string;
  readonly homeDir?: string;
  readonly cancelGraceMs?: number;
  readonly sessionOptions?: AntigravitySessionStoreOptions;
  readonly sessionStore?:
    NamespacedSessionStore<AcpSessionRecord> | SessionStore<AcpSessionRecord>;
  readonly pendingTools?: PendingToolRegistry;
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
  private readonly homeDir?: string;
  private readonly cancelGraceMs: number;
  private readonly sessions: AntigravitySessionStore;
  private readonly activeSessions = new Set<string>();
  public readonly pendingTools: PendingToolRegistry;

  constructor(options: AntigravityProviderOptions = {}) {
    this.homeDir = options.homeDir;
    this.clientFactory =
      options.clientFactory ?? ((cwd: string) => createDefaultClient(cwd, this.homeDir));
    this.defaultWorkingDirectory = options.defaultWorkingDirectory ?? process.cwd();
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.sessions = new AntigravitySessionStore({
      ...options.sessionOptions,
      store: options.sessionOptions?.store ?? options.sessionStore,
    });
    this.pendingTools = options.pendingTools ?? new PendingToolRegistry();
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
    this.pendingTools.clear();
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

    if (input.reasoningEffort && acpModel !== "gemini-3.8-flash") {
      throw new Error(
        `Reasoning effort is not supported for model '${input.model}'. Only gemini-3.8-flash supports thought_level.`,
      );
    }

    if (
      typeof input.toolChoice === "object" &&
      input.toolChoice !== null &&
      input.toolChoice.type === "function"
    ) {
      const requiredName = input.toolChoice.function.name;
      const toolExists = input.tools?.some((t) => t.name === requiredName);
      if (!toolExists) {
        throw new Error(
          `Requested tool '${requiredName}' in tool_choice was not found in declared tools.`,
        );
      }
    }

    if (input.toolResults && input.toolResults.length > 0) {
      for (const result of input.toolResults) {
        this.pendingTools.validateAndConsume(
          result.toolCallId,
          input.sessionId,
          result.toolName,
        );
      }
    }

    const cwd = resolveWorkingDirectory(
      input.workingDirectory,
      this.defaultWorkingDirectory,
    );
    const client = this.clientFactory(cwd);
    this.activeSessions.add(input.sessionId);

    let bridge: AntigravityMcpBridge | undefined;
    let mcpServers: unknown[] | undefined;
    const recordedToolCalls: { id: string; name: string; arguments: string }[] = [];
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const queue = new AsyncEventQueue();

    try {
      if (input.tools && input.tools.length > 0 && input.toolChoice !== "none") {
        bridge = new AntigravityMcpBridge({
          sessionId: input.sessionId,
          tools: input.tools,
          onToolCall: (call) => {
            this.pendingTools.register({
              callId: call.callId,
              toolName: call.name,
              arguments: call.arguments,
              sessionId: input.sessionId,
            });
            const argsStr = JSON.stringify(call.arguments);
            queue.push({
              type: "tool.call",
              runId,
              callId: call.callId,
              toolName: call.name,
              arguments: argsStr,
            });
            recordedToolCalls.push({
              id: call.callId,
              name: call.name,
              arguments: argsStr,
            });
          },
          onToolResult: (callId, toolRes) => {
            queue.push({
              type: "tool.result",
              runId,
              callId,
              output: toolRes.output,
            });
          },
        });
        const mcpConfig = await bridge.start();
        mcpServers = [mcpConfig];
      }

      await client.connect();
      if (typeof client.authenticate === "function") {
        await client.authenticate("oauth-personal");
      }
      const acpSessionId = await this.acquireAcpSession(
        client,
        input.sessionId,
        cwd,
        mcpServers,
      );
      await client.setSessionConfig(acpSessionId, "model", acpModel);
      if (input.reasoningEffort && acpModel === "gemini-3.8-flash") {
        await client.setSessionConfig(
          acpSessionId,
          "thought_level",
          input.reasoningEffort,
        );
      }
      input.signal?.throwIfAborted();

      return this.createRun(
        client,
        input,
        acpSessionId,
        runId,
        queue,
        bridge,
        recordedToolCalls,
      );
    } catch (error) {
      if (bridge) {
        await bridge.dispose().catch(() => {});
      }
      this.activeSessions.delete(input.sessionId);
      await terminatePreservingCause(client, error);
      throw error;
    }
  }

  private async acquireAcpSession(
    client: AntigravityAcpClient,
    gatewaySessionId: string,
    cwd: string,
    mcpServers?: unknown[],
  ): Promise<string> {
    const savedSessionId = await this.sessions.resolve(gatewaySessionId);
    if (savedSessionId !== undefined) {
      try {
        if (mcpServers !== undefined) {
          await client.resumeSession(savedSessionId, cwd, mcpServers);
        } else {
          await client.resumeSession(savedSessionId, cwd);
        }
        return savedSessionId;
      } catch {
        // Resume failures fall back to a new ACP session, as Cursor does.
        await this.sessions.delete(gatewaySessionId);
      }
    }

    const created = await client.createSession(cwd, mcpServers);
    await this.sessions.setPersisted(gatewaySessionId, created.sessionId);
    return created.sessionId;
  }

  private createRun(
    client: AntigravityAcpClient,
    input: AgentExecutionInput,
    acpSessionId: string,
    runId: string,
    queue: AsyncEventQueue,
    bridge: AntigravityMcpBridge | undefined,
    recordedToolCalls: { id: string; name: string; arguments: string }[],
  ): AgentRun {
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
      bridge,
      recordedToolCalls,
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
    bridge: AntigravityMcpBridge | undefined,
    recordedToolCalls: { id: string; name: string; arguments: string }[],
    isCancelRequested: () => boolean,
    getCancellationFailure: () => unknown,
    abortListener: () => void,
  ): Promise<AgentResult> {
    let result: AgentResult;
    try {
      const turn = await client.prompt(acpSessionId, promptBlocksFor(input), {
        timeoutMs: DEFAULT_PROMPT_TURN_TIMEOUT_MS,
        onEvent: (kind, update) => {
          const event = mapAcpUpdateToEvent(runId, kind, update);
          if (event !== undefined) {
            queue.push(event);
          }
        },
      });
      if (input.toolChoice === "required" && recordedToolCalls.length === 0) {
        throw new Error("Model failed to call any tool despite tool_choice='required'.");
      }
      if (
        typeof input.toolChoice === "object" &&
        input.toolChoice !== null &&
        input.toolChoice.type === "function"
      ) {
        const requiredName = input.toolChoice.function.name;
        const called = recordedToolCalls.some((c) => c.name === requiredName);
        if (!called) {
          throw new Error(
            `Model failed to call required tool '${requiredName}' despite tool_choice directive.`,
          );
        }
      }

      result = isCancelResult(turn, isCancelRequested())
        ? createCancelledResult()
        : createCompletedResult(
            {
              text: turn.agentText,
              thoughtText: turn.thoughtText.length > 0 ? turn.thoughtText : undefined,
              toolCalls: recordedToolCalls.length > 0 ? recordedToolCalls : undefined,
            },
            turn.prompt.usage
              ? {
                  inputTokens: turn.prompt.usage.inputTokens,
                  outputTokens: turn.prompt.usage.outputTokens,
                  totalTokens: turn.prompt.usage.totalTokens,
                  thoughtTokens: turn.prompt.usage.thoughtTokens,
                }
              : undefined,
          );
    } catch {
      result = isCancelRequested() ? createCancelledResult() : createFailedResult();
    }

    if (getCancellationFailure() !== undefined) {
      result = createFailedResult();
    }

    let cleanupFailure: unknown;
    try {
      if (bridge) {
        await bridge.dispose().catch(() => {});
      }
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

function createDefaultClient(cwd: string, homeDir?: string): AntigravityAcpClient {
  let env: Record<string, string> | undefined;
  if (homeDir) {
    env = {
      ...(process.env as Record<string, string>),
      HOME: homeDir,
      ANTIGRAVITY_APP_DATA_DIR: homeDir,
      DISPLAY: process.env["DISPLAY"] ?? ":0",
    };
  }
  return new AcpClient({
    command: resolveAgyCommand(),
    cwd,
    env,
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
        reject(error instanceof Error ? error : new Error(String(error)));
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

  const client = clientFactory(cwd);
  let listedCount = 0;
  try {
    await withTimeout(client.connect(), ACP_CONNECT_TIMEOUT_MS, "connect");

    for (const sessionId of dedupedMapped) {
      try {
        await withTimeout(
          client.closeSession(sessionId),
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

    let listed: ListSessionsResult;
    try {
      listed = await withTimeout(
        client.listSessions(),
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
          client.closeSession(sessionId),
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
  } catch (error) {
    warnings.push(
      `connect for session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    closeFailures += dedupedMapped.length;
  } finally {
    await safeTerminate(client);
  }

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

function promptBlocksFor(input: AgentExecutionInput): readonly ContentBlock[] {
  let messageText = input.message;
  if (input.toolChoice === "required") {
    messageText +=
      "\n\n[SYSTEM REQUIREMENT: You MUST invoke at least one of the available functions/tools to complete this request.]";
  } else if (
    typeof input.toolChoice === "object" &&
    input.toolChoice !== null &&
    input.toolChoice.type === "function"
  ) {
    const requiredName = input.toolChoice.function.name;
    messageText += `\n\n[SYSTEM REQUIREMENT: You MUST call the specific tool '${requiredName}'.]`;
  }
  if (input.parallelToolCalls === false) {
    messageText +=
      "\n\n[SYSTEM REQUIREMENT: You must call at most one tool at a time. Parallel tool calling is disabled.]";
  }
  const blocks: ContentBlock[] = [textBlock(messageText)];
  for (const image of input.images ?? []) {
    blocks.push(imageBlock(image.mimeType, image.data));
  }
  return blocks;
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
