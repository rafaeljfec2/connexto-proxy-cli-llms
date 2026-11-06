import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthorizationDeniedError,
  InvalidStateError,
  OperationExpiredError,
  OperationNotFoundError,
} from "./errors.js";
import type {
  AntigravityAccountInfo,
  AntigravityAuthCallbackResult,
  AntigravityAuthManagerOptions,
  AntigravityAuthOperation,
  AntigravityAuthOperationSummary,
  AntigravityAuthStartResponse,
  AntigravityAuthStatusResponse,
  AntigravityViabilityGate,
} from "./types.js";

const DEFAULT_OPERATION_TTL_MS = 600_000; // 10 minutes

const GOOGLE_OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GOOGLE_OAUTH_REDIRECT_URI = "https://antigravity.google/oauth-callback";
const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
].join(" ");

const VIABILITY_GATE: AntigravityViabilityGate = "PARTIALLY_SUPPORTED";

const VIABILITY_LIMITATIONS: readonly string[] = [
  "Google Antigravity personal OAuth credentials are bound to Google internal client ID and CLI local storage.",
  "Exporting personal access or refresh tokens is officially NOT_SUPPORTED by Google CLI/SDK.",
  "Delegated token transfer from AI Hub to Proxy via HTTP headers is officially NOT_SUPPORTED by Google.",
  "Official google-antigravity SDK only supports Gemini API Key and Vertex AI (ADC), rejecting personal OAuth tokens.",
];

export class AntigravityAuthManager {
  private readonly operations = new Map<string, AntigravityAuthOperation>();
  private readonly stateToOperationId = new Map<string, string>();
  private readonly operationTtlMs: number;
  private readonly accountDetector: () => Promise<AntigravityAccountInfo>;
  private readonly cliLoginSpawner?: (params: {
    operationId: string;
    authUrl: string;
    state: string;
  }) => Promise<void>;
  private lastActiveOperationId?: string;

  constructor(options: AntigravityAuthManagerOptions = {}) {
    this.operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS;
    this.accountDetector =
      options.accountDetector ?? (() => this.detectDefaultAccount());
    this.cliLoginSpawner = options.cliLoginSpawner;
  }

  public async startAuth(params?: {
    redirectUri?: string;
  }): Promise<AntigravityAuthStartResponse> {
    this.purgeExpiredOperations();

    const operationId = crypto.randomUUID();
    const state = crypto.randomBytes(24).toString("base64url");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const redirectUri = params?.redirectUri ?? GOOGLE_OAUTH_REDIRECT_URI;

    const url = new URL("https://accounts.google.com/o/oauth2/auth");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES);
    url.searchParams.set("state", state);

    const authUrl = url.toString();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.operationTtlMs).toISOString();

    const operation: AntigravityAuthOperation = {
      operationId,
      status: "pending",
      authUrl,
      state,
      createdAt: now.toISOString(),
      expiresAt,
    };

    this.operations.set(operationId, operation);
    this.stateToOperationId.set(state, operationId);
    this.lastActiveOperationId = operationId;

    if (this.cliLoginSpawner) {
      await this.cliLoginSpawner({ operationId, authUrl, state });
    }

    return {
      operationId,
      status: "pending",
      authUrl,
      state,
      expiresAt,
    };
  }

  public async handleCallback(params: {
    state?: string;
    code?: string;
    error?: string;
    error_description?: string;
  }): Promise<AntigravityAuthCallbackResult> {
    const rawState = params.state?.trim();
    if (!rawState) {
      throw new InvalidStateError("Missing required auth state parameter.");
    }

    const operationId = this.stateToOperationId.get(rawState);
    if (!operationId) {
      throw new InvalidStateError(
        "No active auth operation matches the provided state.",
      );
    }

    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new OperationNotFoundError(operationId);
    }

    const isExpired =
      operation.status === "expired" ||
      Date.now() > new Date(operation.expiresAt).getTime();

    if (isExpired) {
      const expiredOp: AntigravityAuthOperation = {
        ...operation,
        status: "expired",
      };
      this.operations.set(operationId, expiredOp);
      throw new OperationExpiredError(operationId);
    }

    if (params.error) {
      const sanitizedError = params.error_description?.trim() || params.error.trim();
      const failedOp: AntigravityAuthOperation = {
        ...operation,
        status: "failed",
        error: sanitizedError,
      };
      this.operations.set(operationId, failedOp);
      throw new AuthorizationDeniedError(sanitizedError);
    }

    const rawCode = params.code?.trim();
    if (!rawCode) {
      throw new InvalidStateError("Missing authorization code in callback.");
    }

    const accountInfo = await this.accountDetector().catch(() => ({
      authenticated: true,
      account: undefined,
    }));

    const completedOp: AntigravityAuthOperation = {
      ...operation,
      status: "completed",
      account: accountInfo.account,
    };
    this.operations.set(operationId, completedOp);

    return {
      operationId,
      status: "completed",
      account: accountInfo.account,
      message: "Antigravity authentication completed successfully.",
    };
  }

  public getOperation(
    operationId: string,
  ): AntigravityAuthOperationSummary | undefined {
    const operation = this.operations.get(operationId);
    if (!operation) return undefined;

    if (
      operation.status === "pending" &&
      Date.now() > new Date(operation.expiresAt).getTime()
    ) {
      const expiredOp: AntigravityAuthOperation = {
        ...operation,
        status: "expired",
      };
      this.operations.set(operationId, expiredOp);
      return this.toSummary(expiredOp);
    }

    return this.toSummary(operation);
  }

  public async getStatus(): Promise<AntigravityAuthStatusResponse> {
    this.purgeExpiredOperations();
    const accountInfo = await this.accountDetector().catch(
      (): AntigravityAccountInfo => ({
        authenticated: false,
      }),
    );

    const activeOperation = this.lastActiveOperationId
      ? this.getOperation(this.lastActiveOperationId)
      : undefined;

    return {
      authenticated: accountInfo.authenticated,
      account: accountInfo.account,
      lastCheckedAt: new Date().toISOString(),
      viabilityGate: VIABILITY_GATE,
      limitations: VIABILITY_LIMITATIONS,
      activeOperation,
    };
  }

  public resetForTest(): void {
    this.operations.clear();
    this.stateToOperationId.clear();
    this.lastActiveOperationId = undefined;
  }

  private toSummary(op: AntigravityAuthOperation): AntigravityAuthOperationSummary {
    return {
      operationId: op.operationId,
      status: op.status,
      createdAt: op.createdAt,
      expiresAt: op.expiresAt,
      error: op.error,
      account: op.account,
    };
  }

  private purgeExpiredOperations(): void {
    const now = Date.now();
    for (const [id, op] of this.operations.entries()) {
      if (op.status === "pending" && now > new Date(op.expiresAt).getTime()) {
        this.operations.set(id, { ...op, status: "expired" });
      }
    }
  }

  private async detectDefaultAccount(): Promise<AntigravityAccountInfo> {
    try {
      const home = os.homedir();
      const accountsFile = path.join(home, ".gemini", "google_accounts.json");
      const content = await fs.readFile(accountsFile, "utf8");
      const data = JSON.parse(content) as { active?: unknown };
      if (typeof data.active === "string" && data.active.length > 0) {
        return {
          authenticated: true,
          account: data.active,
        };
      }
    } catch {
      // Fallback: check jetski-standalone-oauth-token for email only
      try {
        const home = os.homedir();
        const tokenFile = path.join(home, ".gemini", "jetski-standalone-oauth-token");
        const content = await fs.readFile(tokenFile, "utf8");
        const data = JSON.parse(content) as { id_token_email?: unknown };
        if (typeof data.id_token_email === "string" && data.id_token_email.length > 0) {
          return {
            authenticated: true,
            account: data.id_token_email,
          };
        }
      } catch {
        // No account found
      }
    }

    return {
      authenticated: false,
    };
  }
}
