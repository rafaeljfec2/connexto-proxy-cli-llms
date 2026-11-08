export type BrowserAuthStatus =
  | "starting"
  | "waiting_for_login"
  | "authenticated"
  | "failed"
  | "expired"
  | "disconnected";

export interface BrowserSession {
  readonly id: string;
  readonly principalId: string;
  readonly target: string;
  status: BrowserAuthStatus;
  readonly createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  readonly cdpPort: number;
  readonly userDataDir: string;
  readonly persistentProfile?: boolean;
  processId?: number;
  wsEndpoint?: string;
}

export interface ChromeLaunchOptions {
  readonly executablePath?: string;
  readonly userDataDirRoot?: string;
  readonly userDataDir?: string;
  readonly port?: number;
  readonly targetUrl?: string;
  readonly headless?: boolean;
  readonly extraArgs?: readonly string[];
  readonly startupTimeoutMs?: number;
}

export interface ChromeProcess {
  readonly processId: number;
  readonly port: number;
  readonly userDataDir: string;
  readonly wsEndpoint: string;
  close(): Promise<void>;
  isAlive(): boolean;
}

export class ChromeLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChromeLaunchError";
  }
}

export class SessionOwnershipError extends Error {
  constructor(message = "Session belongs to another principal") {
    super(message);
    this.name = "SessionOwnershipError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`Maximum concurrent browser sessions limit reached (${limit})`);
    this.name = "SessionLimitError";
  }
}

