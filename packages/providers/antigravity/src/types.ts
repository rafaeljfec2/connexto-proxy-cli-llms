export type AntigravityViabilityGate =
  "SUPPORTED" | "PARTIALLY_SUPPORTED" | "NOT_SUPPORTED" | "UNKNOWN";

export type AntigravityAuthOperationStatus =
  "pending" | "completed" | "failed" | "expired";

export interface AntigravityAuthOperation {
  readonly operationId: string;
  readonly status: AntigravityAuthOperationStatus;
  readonly authUrl?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly error?: string;
  readonly account?: string;
}

export interface AntigravityAuthOperationSummary {
  readonly operationId: string;
  readonly status: AntigravityAuthOperationStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly error?: string;
  readonly account?: string;
}

export interface AntigravityAuthStartResponse {
  readonly operationId: string;
  readonly status: AntigravityAuthOperationStatus;
  readonly authUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface AntigravityAuthStatusResponse {
  readonly authenticated: boolean;
  readonly account?: string;
  readonly lastCheckedAt: string;
  readonly viabilityGate: AntigravityViabilityGate;
  readonly limitations: readonly string[];
  readonly activeOperation?: AntigravityAuthOperationSummary;
}

export interface AntigravityAuthCallbackResult {
  readonly operationId: string;
  readonly status: AntigravityAuthOperationStatus;
  readonly account?: string;
  readonly message: string;
}

export interface AntigravityAccountInfo {
  readonly authenticated: boolean;
  readonly account?: string;
}

export interface AntigravityAuthManagerOptions {
  readonly cliPath?: string;
  readonly operationTtlMs?: number;
  readonly accountDetector?: () => Promise<AntigravityAccountInfo>;
  readonly cliLoginSpawner?: (params: {
    operationId: string;
    authUrl: string;
    state: string;
  }) => Promise<void>;
}
