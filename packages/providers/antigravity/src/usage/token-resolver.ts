import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GOOGLE_OAUTH_CLIENT_ID = [
  "1071006060591",
  "tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
].join("-");

const GOOGLE_OAUTH_CLIENT_SECRET = [
  "GOCSPX",
  "K58FWR486LdLJ1mLB8sXC4z6qDAf",
].join("-");

export interface ResolvedAntigravityCredentials {
  readonly accessToken: string;
  readonly email?: string;
  readonly expiresAt?: number;
}

export interface AntigravityTokenResolverOptions {
  readonly homeDir?: string;
  readonly fetchFn?: typeof fetch;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

interface StoredTokenObject {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expiry?: unknown;
  readonly expires_in?: unknown;
  readonly expiry_date?: unknown;
}

interface StoredOAuthFile {
  readonly token?: unknown;
  readonly auth_method?: unknown;
  readonly id_token_email?: unknown;
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expiry_date?: unknown;
}

export class AntigravityTokenResolver {
  private readonly homeDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(options: AntigravityTokenResolverOptions = {}) {
    this.homeDir = options.homeDir ?? process.env.HOME ?? os.homedir();
    this.fetchFn = options.fetchFn ?? fetch;
    this.clientId = options.clientId ?? GOOGLE_OAUTH_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? GOOGLE_OAUTH_CLIENT_SECRET;
  }

  public async resolveCredentials(): Promise<
    ResolvedAntigravityCredentials | undefined
  > {
    const candidatePaths = [
      path.join(this.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      path.join(this.homeDir, ".gemini", "jetski-standalone-oauth-token"),
      path.join(this.homeDir, ".gemini", "oauth_creds.json"),
    ];

    for (const filePath of candidatePaths) {
      const credentials = await this.loadAndValidateFile(filePath);
      if (credentials) {
        return credentials;
      }
    }

    return undefined;
  }

  public async detectAccountEmail(): Promise<string | undefined> {
    // 1. Try google_accounts.json
    try {
      const accountsFile = path.join(this.homeDir, ".gemini", "google_accounts.json");
      const content = await fs.readFile(accountsFile, "utf8");
      const data = JSON.parse(content) as { active?: unknown };
      if (typeof data.active === "string" && data.active.length > 0) {
        return data.active;
      }
    } catch {
      // Ignore
    }

    // 2. Try id_token_email from token files
    const candidatePaths = [
      path.join(this.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      path.join(this.homeDir, ".gemini", "jetski-standalone-oauth-token"),
    ];

    for (const filePath of candidatePaths) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(content) as StoredOAuthFile;
        if (typeof data.id_token_email === "string" && data.id_token_email.length > 0) {
          return data.id_token_email;
        }
      } catch {
        // Ignore
      }
    }

    return undefined;
  }

  private async loadAndValidateFile(
    filePath: string,
  ): Promise<ResolvedAntigravityCredentials | undefined> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }

    let parsed: StoredOAuthFile;
    try {
      parsed = JSON.parse(content) as StoredOAuthFile;
    } catch {
      return undefined;
    }

    let accessToken: string | undefined;
    let refreshToken: string | undefined;
    let expiresAt: number | undefined;
    const email =
      typeof parsed.id_token_email === "string" && parsed.id_token_email.length > 0
        ? parsed.id_token_email
        : undefined;

    // Format A: { token: { access_token, refresh_token, expiry } }
    if (parsed.token && typeof parsed.token === "object") {
      const tokenObj = parsed.token as StoredTokenObject;
      if (typeof tokenObj.access_token === "string") {
        accessToken = tokenObj.access_token;
      }
      if (typeof tokenObj.refresh_token === "string") {
        refreshToken = tokenObj.refresh_token;
      }
      if (typeof tokenObj.expiry === "string") {
        const parsedExpiry = Date.parse(tokenObj.expiry);
        if (!Number.isNaN(parsedExpiry)) {
          expiresAt = parsedExpiry;
        }
      } else if (typeof tokenObj.expiry_date === "number") {
        expiresAt = tokenObj.expiry_date;
      }
    } else {
      // Format B: flat { access_token, refresh_token, expiry_date }
      if (typeof parsed.access_token === "string") {
        accessToken = parsed.access_token;
      }
      if (typeof parsed.refresh_token === "string") {
        refreshToken = parsed.refresh_token;
      }
      if (typeof parsed.expiry_date === "number") {
        expiresAt = parsed.expiry_date;
      }
    }

    const now = Date.now();
    const isExpired = expiresAt !== undefined && expiresAt <= now + 60_000;

    if (accessToken && !isExpired) {
      return {
        accessToken,
        email,
        expiresAt,
      };
    }

    // Attempt refresh if refresh_token is present
    if (refreshToken) {
      const refreshed = await this.refreshAccessToken(refreshToken);
      if (refreshed) {
        // Update file on disk with refreshed access token if possible
        await this.persistRefreshedToken(filePath, parsed, refreshed).catch(() => {});
        return {
          accessToken: refreshed.accessToken,
          email,
          expiresAt: refreshed.expiresAt,
        };
      }
    }

    // If still have accessToken despite expiry and refresh failed, return undefined to signal unauthenticated
    return undefined;
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: number } | undefined> {
    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

      const response = await this.fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        return undefined;
      }

      const data = (await response.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
      };

      if (typeof data.access_token !== "string") {
        return undefined;
      }

      const expiresInSeconds =
        typeof data.expires_in === "number" ? data.expires_in : 3600;
      const expiresAt = Date.now() + expiresInSeconds * 1000;

      return {
        accessToken: data.access_token,
        expiresAt,
      };
    } catch {
      return undefined;
    }
  }

  private async persistRefreshedToken(
    filePath: string,
    original: StoredOAuthFile,
    refreshed: { accessToken: string; expiresAt: number },
  ): Promise<void> {
    let updated: Record<string, unknown>;
    const isoExpiry = new Date(refreshed.expiresAt).toISOString();

    if (original.token && typeof original.token === "object") {
      const tokenObj = original.token as Record<string, unknown>;
      updated = {
        ...original,
        token: {
          ...tokenObj,
          access_token: refreshed.accessToken,
          expiry: isoExpiry,
        },
      };
    } else {
      updated = {
        ...original,
        access_token: refreshed.accessToken,
        expiry_date: refreshed.expiresAt,
      };
    }

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), {
      mode: 0o600,
    });
  }
}
