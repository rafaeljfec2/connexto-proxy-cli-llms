const JSON_RPC_ERROR_AUTH_REQUIRED = -32000;

export class AcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpNotConnectedError extends AcpError {
  constructor(message = "ACP connection is not initialized.") {
    super(message);
    this.name = "AcpNotConnectedError";
  }
}

export class AcpProtocolError extends AcpError {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "AcpProtocolError";
    this.code = code;
    this.data = data;
  }
}

export class AcpAuthRequiredError extends AcpProtocolError {
  constructor(reason?: string) {
    const message =
      reason === undefined || reason.length === 0
        ? "Agent requires authentication before this operation."
        : reason;
    super(message, JSON_RPC_ERROR_AUTH_REQUIRED);
    this.name = "AcpAuthRequiredError";
  }
}

export class AcpTimeoutError extends AcpError {
  public readonly method: string;
  public readonly timeoutMs: number;
  private cancellationFailureValue: unknown;

  constructor(method: string, timeoutMs: number) {
    super(`ACP request '${method}' timed out after ${timeoutMs}ms.`);
    this.name = "AcpTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }

  public get cancellationFailure(): unknown {
    return this.cancellationFailureValue;
  }

  public recordCancellationFailure(error: unknown): void {
    this.cancellationFailureValue = error;
  }
}

export class AcpProcessError extends AcpError {
  public readonly exitCode: number | null;
  public readonly signal: string | null;

  constructor(
    message: string,
    exitCode: number | null,
    signal: string | null,
    public readonly stderrTail = "",
  ) {
    super(message);
    this.name = "AcpProcessError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class AcpSpawnError extends AcpProcessError {
  constructor(command: string, details: string) {
    super(
      `Failed to start ACP agent process '${command}': ${details}`,
      null,
      null,
      details,
    );
    this.name = "AcpSpawnError";
  }
}

export class AcpHandshakeError extends AcpError {
  constructor(message: string) {
    super(message);
    this.name = "AcpHandshakeError";
  }
}

export class AcpTerminatedError extends AcpError {
  constructor(message = "ACP client has already been terminated.") {
    super(message);
    this.name = "AcpTerminatedError";
  }
}

export class AcpTurnInProgressError extends AcpError {
  constructor() {
    super("This ACP client already has a prompt turn in progress.");
    this.name = "AcpTurnInProgressError";
  }
}
