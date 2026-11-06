import { AgentProcessTransport } from "./agent-transport.js";
import {
  runAgentTurn,
  type AgentTurnResult,
  type RunAgentTurnOptions,
  type TurnTransport,
} from "./agent-turn.js";
import {
  AcpAuthRequiredError,
  AcpHandshakeError,
  AcpProtocolError,
  AcpTurnInProgressError,
} from "./errors.js";
import {
  ACP_PROTOCOL_VERSION,
  DEFAULT_AUTH_METHOD_ID,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_PROCESS_GRACE_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  JSON_RPC_ERROR_AUTH_REQUIRED,
} from "./constants.js";
import type {
  AcpClientOptions,
  AgentRequestListener,
  AgentRequestResponse,
  ContentBlock,
  InitializeResult,
  ListSessionsResult,
  SessionConfigOption,
} from "./types.js";

export const DEFAULT_CLIENT_ARGS = ["acp", "--disable-telemetry"] as const;
const REQUEST_PERMISSION_METHOD = "session/request_permission";

type RpcErrorPayload = { code: number; message: string };
type RpcResponse = { result?: unknown; error?: RpcErrorPayload };
type ClientOptions = AcpClientOptions;

function rpcError(response: RpcResponse, method: string): Error {
  const payload = response.error ?? { code: -32602, message: "no response payload" };
  if (payload.code === JSON_RPC_ERROR_AUTH_REQUIRED) {
    return new AcpAuthRequiredError(payload.message);
  }
  return new AcpProtocolError(
    `${method} failed (${payload.code}): ${payload.message}`,
    payload.code,
  );
}

export class AcpClient {
  private transport?: AgentProcessTransport;
  private initializeResult?: InitializeResult;
  private nextRequestId = 10;
  private activePromptTurn = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  private readonly options: ClientOptions;

  public get isConnected(): boolean {
    return this.transport?.isRunning === true && this.initializeResult !== undefined;
  }

  public get protocolVersion(): number {
    this.assertConnected();
    return this.initializeResult!.protocolVersion;
  }

  public get agentCapabilities(): InitializeResult["agentCapabilities"] {
    this.assertConnected();
    return this.initializeResult!.agentCapabilities;
  }

  public get agentInfo(): { name: string; version: string } {
    this.assertConnected();
    return this.initializeResult!.agentInfo;
  }

  public get authMethodIds(): readonly string[] {
    return (this.initializeResult?.authMethods ?? []).map((method) => method.id);
  }

  public async connect(): Promise<void> {
    if (this.transport?.isRunning === true) {
      throw new AcpHandshakeError(
        "ACP client is already connected; terminate it before reconnecting.",
      );
    }
    const transport = new AgentProcessTransport({
      command: this.options.command,
      args: this.options.args ?? DEFAULT_CLIENT_ARGS,
      cwd: this.options.cwd,
      env: this.options.env,
      spawnFn: this.options.spawnFn,
      exitListener: (exitCode, signal) => {
        if (this.transport === transport) {
          this.transport = undefined;
          this.initializeResult = undefined;
        }
        this.options.onExit?.(exitCode, signal);
      },
      invalidLineListener: this.options.onInvalidLine,
      agentRequestListener: this.agentRequestListener(),
    });
    this.transport = transport;
    transport.start();
    transport.onNotification((method, params) =>
      this.options.onNotification?.(method, params),
    );
    await this.performHandshake();
  }

  public async terminate(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.initializeResult = undefined;
    await transport?.terminate(
      this.options.timeouts?.processGraceMs ?? DEFAULT_PROCESS_GRACE_MS,
    );
  }

  public async authenticate(methodId?: string): Promise<void> {
    const transport = this.transportRef("authenticate");
    const response = await transport.request(
      this.nextRequestId++,
      "authenticate",
      { methodId: methodId ?? this.options.authMethodId ?? DEFAULT_AUTH_METHOD_ID },
      this.options.timeouts?.authMs ?? DEFAULT_AUTH_TIMEOUT_MS,
    );
    if (response.error !== undefined) {
      throw rpcError(response, "authenticate");
    }
  }

  public async createSession(
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<{ sessionId: string; configOptions?: readonly SessionConfigOption[] }> {
    const result = await this.sessionCall("session/new", { cwd, mcpServers });
    const payload = result as { sessionId?: unknown };
    if (typeof payload.sessionId !== "string") {
      throw new AcpHandshakeError("session/new returned no sessionId.");
    }
    return payload as {
      sessionId: string;
      configOptions?: readonly SessionConfigOption[];
    };
  }

  public async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    const result = await this.sessionCall("session/resume", {
      sessionId,
      cwd,
      mcpServers,
    });
    return (result ?? {}) as Record<string, unknown>;
  }

  public async listSessions(): Promise<ListSessionsResult> {
    const result = await this.sessionCall("session/list", {});
    const sessions = (result as { sessions?: ListSessionsResult["sessions"] })[
      "sessions"
    ];
    return { sessions: sessions ?? [] };
  }

  public async setSessionConfig(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<readonly SessionConfigOption[]> {
    const result = await this.sessionCall("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    const configOptions = (
      result as { configOptions?: readonly SessionConfigOption[] }
    )["configOptions"];
    return configOptions ?? [];
  }

  public async closeSession(sessionId: string): Promise<void> {
    await this.sessionCall("session/close", { sessionId });
  }

  public async prompt(
    sessionId: string,
    blocks: readonly ContentBlock[],
    options: RunAgentTurnOptions = {},
  ): Promise<AgentTurnResult> {
    this.assertConnected();
    if (this.activePromptTurn) {
      throw new AcpTurnInProgressError();
    }
    this.activePromptTurn = true;
    try {
      try {
        return await runAgentTurn(this.turnTransport(), sessionId, blocks, {
          ...options,
          timeoutMs: options.timeoutMs ?? this.options.timeouts?.promptTurnMs,
        });
      } catch (error) {
        if (!(error instanceof AcpAuthRequiredError)) {
          throw error;
        }
        await this.authenticate();
        return await runAgentTurn(this.turnTransport(), sessionId, blocks, {
          ...options,
          timeoutMs: options.timeoutMs ?? this.options.timeouts?.promptTurnMs,
        });
      }
    } finally {
      this.activePromptTurn = false;
    }
  }

  public cancelTurn(sessionId: string): void {
    this.assertConnected();
    this.transport!.notify("session/cancel", { sessionId });
  }

  private sessionCall(method: string, params: unknown): Promise<unknown> {
    this.assertConnected();
    return (async () => {
      const first = await this.send(method, params);
      if (first.error?.code === JSON_RPC_ERROR_AUTH_REQUIRED) {
        await this.authenticate();
        const second = await this.send(method, params);
        return assertResult(second, method);
      }
      return assertResult(first, method);
    })();
  }

  private async send(method: string, params: unknown): Promise<RpcResponse> {
    const transport = this.transportRef(method);
    return transport.request(
      this.nextRequestId++,
      method,
      params,
      this.options.timeouts?.sessionLifecycleMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    );
  }

  private turnTransport(): TurnTransport {
    const transport = this.transportRef("session/prompt");
    return {
      request: async (method, params, requestTimeoutMs) => {
        const response = await transport.request(
          this.nextRequestId++,
          method,
          params,
          requestTimeoutMs,
        );
        return response.error !== undefined
          ? { error: response.error }
          : { result: response.result };
      },
      notify: (method, params) => transport.notify(method, params),
      onNotification: (listener) => transport.onNotification(listener),
    };
  }

  private transportRef(forMethod: string): AgentProcessTransport {
    if (this.transport === undefined) {
      throw new AcpHandshakeError(`Client is not connected; cannot call ${forMethod}.`);
    }
    return this.transport;
  }

  private async performHandshake(): Promise<void> {
    const transport = this.transportRef("initialize");
    const response = await transport
      .request(
        this.nextRequestId++,
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: this.options.clientInfo ?? {
            name: "connexto-proxy",
            version: "0.0.0",
          },
        },
        this.options.timeouts?.initializeMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      )
      .catch(async (error: unknown) => {
        await this.dropConnection();
        throw error;
      });
    if (response.error !== undefined) {
      await this.dropConnection();
      throw rpcError(response, "initialize");
    }
    const payload = response.result as Partial<InitializeResult> | undefined;
    if (
      payload === undefined ||
      payload.protocolVersion !== ACP_PROTOCOL_VERSION ||
      typeof payload.agentInfo?.name !== "string"
    ) {
      await this.dropConnection();
      throw new AcpHandshakeError(
        `Incompatible ACP protocol version: ${String(payload?.protocolVersion)}`,
      );
    }
    this.initializeResult = {
      protocolVersion: payload.protocolVersion,
      agentCapabilities: payload.agentCapabilities ?? {},
      agentInfo: payload.agentInfo,
      authMethods: payload.authMethods ?? [],
    };
  }

  private agentRequestListener(): AgentRequestListener {
    const permissionDenial: AgentRequestResponse = {
      result: { outcome: { outcome: "cancelled" } },
    };
    return (id, method, params): AgentRequestResponse | undefined => {
      void id;
      void params;
      if (method === REQUEST_PERMISSION_METHOD) {
        return permissionDenial;
      }
      return undefined;
    };
  }

  private assertConnected(): void {
    if (this.transport?.isRunning !== true || this.initializeResult === undefined) {
      throw new AcpHandshakeError("Client has not completed the ACP handshake.");
    }
  }

  /** Shuts the process down and resets state after a broken handshake. */
  private async dropConnection(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    await transport?.terminate(
      this.options.timeouts?.processGraceMs ?? DEFAULT_PROCESS_GRACE_MS,
    );
  }
}

function assertResult(response: RpcResponse, method: string): unknown {
  if (response.error !== undefined) {
    throw rpcError(response, method);
  }
  return response.result;
}

export type { ListSessionsResult, SessionConfigOption };
