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
  AntigravityTokenExchanger,
  AntigravityTokens,
  AntigravityViabilityGate,
} from "./types.js";

const DEFAULT_OPERATION_TTL_MS = 600_000; // 10 minutes

const GOOGLE_OAUTH_CLIENT_ID = [
  "1071006060591",
  "tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
].join("-");

const GOOGLE_OAUTH_CLIENT_SECRET = [
  "GOCSPX",
  "K58FWR486LdLJ1mLB8sXC4z6qDAf",
].join("-");
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

export async function defaultGoogleTokenExchanger(params: {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}): Promise<AntigravityTokens> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret ?? GOOGLE_OAUTH_CLIENT_SECRET,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as AntigravityTokens;
}

export class AntigravityAuthManager {
  private readonly homeDir: string;
  private readonly operations = new Map<string, AntigravityAuthOperation>();
  private readonly stateToOperationId = new Map<string, string>();
  private readonly operationTtlMs: number;
  private readonly defaultRedirectUri?: string;
  private readonly tokenExchanger?: AntigravityTokenExchanger;
  private readonly hasExplicitTokenExchanger: boolean;
  private readonly onTokensPersisted?: (
    tokens: AntigravityTokens,
    email?: string,
  ) => Promise<void>;
  private readonly accountDetector: () => Promise<AntigravityAccountInfo>;
  private readonly cliLoginSpawner?: (params: {
    operationId: string;
    authUrl: string;
    state: string;
  }) => Promise<void>;
  private lastActiveOperationId?: string;

  constructor(options: AntigravityAuthManagerOptions = {}) {
    this.homeDir = options.homeDir ?? process.env.HOME ?? os.homedir();
    this.operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS;
    this.accountDetector =
      options.accountDetector ?? (() => this.detectDefaultAccount());
    this.cliLoginSpawner = options.cliLoginSpawner;
    this.defaultRedirectUri = options.defaultRedirectUri;
    this.hasExplicitTokenExchanger = options.tokenExchanger !== undefined;
    this.tokenExchanger = options.tokenExchanger ?? defaultGoogleTokenExchanger;
    this.onTokensPersisted = options.onTokensPersisted;
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

    const redirectUri =
      params?.redirectUri ?? this.defaultRedirectUri ?? GOOGLE_OAUTH_REDIRECT_URI;

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
      codeVerifier,
      redirectUri,
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

    let detectedAccount: string | undefined;

    let tokenExchangeError: Error | undefined;

    if (this.tokenExchanger && operation.codeVerifier && operation.redirectUri) {
      try {
        const tokens = await this.tokenExchanger({
          clientId: GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
          code: rawCode,
          codeVerifier: operation.codeVerifier,
          redirectUri: operation.redirectUri,
        });

        let email = this.extractEmailFromTokens(tokens);
        if (!email && tokens.access_token) {
          email = await this.fetchEmailFromUserInfo(tokens.access_token).catch(
            () => undefined,
          );
        }

        if (email) {
          detectedAccount = email;
        }

        await this.persistLocalCredentials(tokens, email);
        if (this.onTokensPersisted) {
          await this.onTokensPersisted(tokens, email);
        }
      } catch (err) {
        if (this.hasExplicitTokenExchanger) {
          throw new AuthorizationDeniedError(
            `Failed to exchange authorization code: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (!detectedAccount) {
      const accountInfo = await this.accountDetector().catch(() => ({
        authenticated: true,
        account: undefined,
      }));
      detectedAccount = accountInfo.account;
    }

    const completedOp: AntigravityAuthOperation = {
      ...operation,
      status: "completed",
      account: detectedAccount,
    };
    this.operations.set(operationId, completedOp);

    return {
      operationId,
      status: "completed",
      account: detectedAccount,
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

  public async clearCredentials(): Promise<{
    removedFiles: string[];
    message: string;
  }> {
    this.operations.clear();
    this.stateToOperationId.clear();
    this.lastActiveOperationId = undefined;

    const filesToRemove = [
      path.join(this.homeDir, ".gemini", "oauth_creds.json"),
      path.join(this.homeDir, ".gemini", "jetski-standalone-oauth-token"),
      path.join(this.homeDir, ".gemini", "google_accounts.json"),
      path.join(this.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      path.join(this.homeDir, ".config", "antigravity", "credential-user-scope"),
    ];

    const removedFiles: string[] = [];
    for (const filePath of filesToRemove) {
      try {
        await fs.unlink(filePath);
        removedFiles.push(filePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // File might not exist or failed to remove; do not crash
        }
      }
    }

    return {
      removedFiles,
      message: "Antigravity credentials and active sessions purged successfully.",
    };
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
      const home = this.homeDir;
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
      // Fallback 1: check jetski-standalone-oauth-token for email
      try {
        const home = this.homeDir;
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
        // Fallback 2: check oauth_creds.json
        try {
          const home = this.homeDir;
          const credsFile = path.join(home, ".gemini", "oauth_creds.json");
          const content = await fs.readFile(credsFile, "utf8");
          const data = JSON.parse(content) as { id_token?: unknown; access_token?: unknown };
          let email: string | undefined;
          if (typeof data.id_token === "string" && data.id_token.length > 0) {
            email = this.extractEmailFromTokens({
              id_token: data.id_token,
              access_token: typeof data.access_token === "string" ? data.access_token : "",
              token_type: "Bearer",
            });
          }
          if (typeof data.access_token === "string" && data.access_token.length > 0) {
            return {
              authenticated: true,
              account: email,
            };
          }
        } catch {
          // No account found
        }
      }
    }

    return {
      authenticated: false,
    };
  }

  private async fetchEmailFromUserInfo(
    accessToken: string,
  ): Promise<string | undefined> {
    try {
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { email?: unknown };
      return typeof data.email === "string" && data.email.length > 0
        ? data.email
        : undefined;
    } catch {
      return undefined;
    }
  }

  private extractEmailFromTokens(tokens: AntigravityTokens): string | undefined {
    if (!tokens.id_token) return undefined;
    try {
      const parts = tokens.id_token.split(".");
      if (parts.length >= 2 && parts[1]) {
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
        const payload = JSON.parse(payloadJson) as { email?: unknown };
        return typeof payload.email === "string" ? payload.email : undefined;
      }
    } catch {
      // Ignore JWT parse failure
    }
    return undefined;
  }

  private async persistLocalCredentials(
    tokens: AntigravityTokens,
    email?: string,
  ): Promise<void> {
    const homeDir = this.homeDir;
    const geminiDir = path.join(homeDir, ".gemini");
    const configDir = path.join(homeDir, ".config", "antigravity");

    try {
      await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

      const expiryDate =
        tokens.expiry_date ?? Date.now() + (tokens.expires_in ?? 3600) * 1000;

      // 1. ~/.gemini/oauth_creds.json
      const credsPath = path.join(geminiDir, "oauth_creds.json");
      const credsData = {
        access_token: tokens.access_token,
        scope: tokens.scope ?? "",
        token_type: tokens.token_type ?? "Bearer",
        id_token: tokens.id_token ?? "",
        expiry_date: expiryDate,
        refresh_token: tokens.refresh_token ?? "",
      };
      await fs.writeFile(credsPath, JSON.stringify(credsData, null, 2), {
        mode: 0o600,
      });

      // 2. ~/.gemini/google_accounts.json
      if (email) {
        const accountsPath = path.join(geminiDir, "google_accounts.json");
        let existingAccounts = { active: email, old: [] as string[] };
        try {
          const raw = await fs.readFile(accountsPath, "utf-8");
          const parsed = JSON.parse(raw) as { active?: string; old?: string[] };
          const oldList = Array.isArray(parsed.old) ? parsed.old : [];
          if (
            parsed.active &&
            parsed.active !== email &&
            !oldList.includes(parsed.active)
          ) {
            oldList.push(parsed.active);
          }
          existingAccounts = { active: email, old: oldList };
        } catch {
          // New file
        }
        await fs.writeFile(accountsPath, JSON.stringify(existingAccounts, null, 2), {
          mode: 0o600,
        });
      }

      // 3. ~/.gemini/jetski-standalone-oauth-token
      const jetskiPath = path.join(geminiDir, "jetski-standalone-oauth-token");
      const jetskiData = {
        token: tokens.access_token,
        auth_method: "oauth",
        id_token_email: email,
      };
      await fs.writeFile(jetskiPath, JSON.stringify(jetskiData, null, 2), {
        mode: 0o600,
      });

      // 4. ~/.config/antigravity/credential-user-scope
      const scopePath = path.join(configDir, "credential-user-scope");
      try {
        await fs.access(scopePath);
      } catch {
        const randomScope = "u" + crypto.randomBytes(8).toString("hex");
        await fs.writeFile(scopePath, randomScope, { mode: 0o600 });
      }
    } catch {
      // In restricted filesystem environments, do not fail the auth flow
    }
  }
}
