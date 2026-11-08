import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface HostBridgeClientOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly defaultTimeoutMs?: number;
}

export interface HostBridgeSessionDto {
  readonly sessionId: string;
  readonly principalId: string;
  readonly target: string;
  readonly status:
    | "starting"
    | "waiting_for_login"
    | "authenticated"
    | "failed"
    | "expired"
    | "disconnected";
  readonly connected?: boolean;
  readonly currentUrl?: string;
  readonly details?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
}

export class BridgeError extends Error {
  public readonly code: string;
  public readonly status?: number;

  constructor(message: string, code = "bridge_error", status?: number) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

export class BridgeUnauthorizedError extends BridgeError {
  constructor(message = "Unauthorized bridge access") {
    super(message, "unauthorized", 401);
    this.name = "BridgeUnauthorizedError";
  }
}

export class BridgeForbiddenError extends BridgeError {
  constructor(message = "Session belongs to another principal") {
    super(message, "forbidden", 403);
    this.name = "BridgeForbiddenError";
  }
}

export class BridgeSessionNotFoundError extends BridgeError {
  constructor(sessionId: string) {
    super(`Bridge session ${sessionId} not found`, "not_found", 404);
    this.name = "BridgeSessionNotFoundError";
  }
}

function getLinuxDefaultGateway(): string | null {
  try {
    if (process.platform !== "linux") {
      return null;
    }
    if (!fs.existsSync("/proc/net/route")) {
      return null;
    }
    const content = fs.readFileSync("/proc/net/route", "utf-8");
    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === "00000000" && parts[2]) {
        const hex = parts[2];
        const b1 = Number.parseInt(hex.substring(0, 2), 16);
        const b2 = Number.parseInt(hex.substring(2, 4), 16);
        const b3 = Number.parseInt(hex.substring(4, 6), 16);
        const b4 = Number.parseInt(hex.substring(6, 8), 16);
        return `${b4}.${b3}.${b2}.${b1}`;
      }
    }
  } catch {
    // Ignore route read failure
  }
  return null;
}

export class HostBrowserBridgeClient {
  private activeBaseUrl: string;
  private readonly fallbackBaseUrls: string[] = [];
  private readonly token: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: HostBridgeClientOptions = {}) {
    const rawUrl =
      options.baseUrl ??
      process.env.BROWSER_BRIDGE_URL ??
      "http://host.docker.internal:4318";
    this.activeBaseUrl = rawUrl.replace(/\/$/, "");
    this.token =
      options.token ??
      process.env.BROWSER_BRIDGE_TOKEN ??
      "dev-bridge-token";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;

    const portMatch = this.activeBaseUrl.match(/:(\d+)$/);
    const port = portMatch ? portMatch[1] : "4318";
    const gw = getLinuxDefaultGateway();
    if (gw && gw !== "0.0.0.0") {
      const gwUrl = `http://${gw}:${port}`;
      if (this.activeBaseUrl !== gwUrl) {
        this.fallbackBaseUrls.push(gwUrl);
      }
    }
    if (this.activeBaseUrl !== `http://127.0.0.1:${port}`) {
      this.fallbackBaseUrls.push(`http://127.0.0.1:${port}`);
    }
  }

  public async health(): Promise<{ status: string; activeSessions: number }> {
    const res = await this.requestJson<{ status: string; activeSessions: number }>(
      "/health",
      { method: "GET" },
      false,
    );
    return res;
  }

  public async listSessions(
    principalId?: string,
  ): Promise<HostBridgeSessionDto[]> {
    const query = principalId ? `?principalId=${encodeURIComponent(principalId)}` : "";
    const res = await this.requestJson<{ sessions: HostBridgeSessionDto[] }>(
      `/internal/browser/sessions${query}`,
      { method: "GET" },
      true,
    );
    return res.sessions ?? [];
  }

  public async createSession(params: {
    sessionId?: string;
    principalId: string;
    target: string;
    targetUrl?: string;
    ttlMs?: number;
    headless?: boolean;
    persistentProfile?: boolean;
  }): Promise<HostBridgeSessionDto> {
    return this.requestJson<HostBridgeSessionDto>(
      "/internal/browser/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          id: params.sessionId,
          principalId: params.principalId,
          target: params.target,
          targetUrl: params.targetUrl,
          ttlMs: params.ttlMs,
          headless: params.headless,
          persistentProfile: params.persistentProfile,
        }),
      },
      true,
    );
  }

  public async getSession(
    sessionId: string,
    principalId: string,
  ): Promise<HostBridgeSessionDto> {
    const query = new URLSearchParams({ principalId }).toString();
    return this.requestJson<HostBridgeSessionDto>(
      `/internal/browser/sessions/${encodeURIComponent(sessionId)}?${query}`,
      {
        method: "GET",
        headers: {
          "x-principal-id": principalId,
        },
      },
      true,
    );
  }

  public async closeSession(
    sessionId: string,
    principalId: string,
  ): Promise<void> {
    const query = new URLSearchParams({ principalId }).toString();
    await this.requestVoid(
      `/internal/browser/sessions/${encodeURIComponent(sessionId)}?${query}`,
      {
        method: "DELETE",
        headers: {
          "x-principal-id": principalId,
        },
      },
      true,
    );
  }

  public async executeInSession(
    sessionId: string,
    principalId: string,
    action: "evaluate" | "navigate",
    param: string,
  ): Promise<unknown> {
    const res = await this.requestJson<{ success: boolean; result?: unknown }>(
      `/internal/browser/sessions/${encodeURIComponent(sessionId)}/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId,
          action,
          param,
        }),
      },
      true,
    );
    return res.result;
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    requireAuth: boolean,
  ): Promise<T> {
    const res = await this.doFetch(path, init, requireAuth);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BridgeError(
        `Failed to parse Bridge JSON response: ${text}`,
        "invalid_response",
        res.status,
      );
    }
  }

  private async requestVoid(
    path: string,
    init: RequestInit,
    requireAuth: boolean,
  ): Promise<void> {
    await this.doFetch(path, init, requireAuth);
  }

  private async doFetch(
    path: string,
    init: RequestInit,
    requireAuth: boolean,
  ): Promise<Response> {
    const candidateUrls = [
      this.activeBaseUrl,
      ...this.fallbackBaseUrls.filter((u) => u !== this.activeBaseUrl),
    ];
    let lastError: unknown;

    for (const baseUrl of candidateUrls) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");

      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      if (requireAuth) {
        headers.set("Authorization", `Bearer ${this.token}`);
        headers.set("x-bridge-token", this.token);
      }

      try {
        const url = `${baseUrl}${path}`;
        const res = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        if (baseUrl !== this.activeBaseUrl) {
          this.activeBaseUrl = baseUrl;
        }

        if (!res.ok) {
          let errorMsg = `Bridge request failed with status ${res.status}`;
          let errorCode = "bridge_request_failed";
          try {
            const body = (await res.json()) as { error?: { message?: string; code?: string } };
            if (body?.error?.message) {
              errorMsg = body.error.message;
            }
            if (body?.error?.code) {
              errorCode = body.error.code;
            }
          } catch {
            // Fallback to status text
          }

          if (res.status === 401) {
            throw new BridgeUnauthorizedError(errorMsg);
          }
          if (res.status === 403) {
            throw new BridgeForbiddenError(errorMsg);
          }
          if (res.status === 404) {
            throw new BridgeSessionNotFoundError(path);
          }
          throw new BridgeError(errorMsg, errorCode, res.status);
        }

        return res;
      } catch (err) {
        if (err instanceof BridgeError) {
          throw err;
        }
        lastError = err;
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (this.tryAutoStartBridgeOnWindows()) {
      // Wait for server to boot and retry candidate URLs once
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return this.doFetch(path, init, requireAuth);
    }

    if (lastError instanceof DOMException && lastError.name === "AbortError") {
      throw new BridgeError(
        `Bridge request timed out after ${this.defaultTimeoutMs}ms`,
        "timeout",
        504,
      );
    }
    const cause = (lastError as { cause?: Error })?.cause;
    const causeMsg = cause?.message ? ` (${cause.message})` : "";
    throw new BridgeError(
      `Bridge connection failed: ${lastError instanceof Error ? lastError.message : String(lastError)}${causeMsg}`,
      "connection_error",
      502,
    );
  }

  private autoStartAttempted = false;

  private tryAutoStartBridgeOnWindows(): boolean {
    if (this.autoStartAttempted) {
      return false;
    }
    this.autoStartAttempted = true;

    try {
      if (process.platform === "linux") {
        const isWsl =
          fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ||
          (fs.existsSync("/proc/version") &&
            fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft"));
        if (isWsl) {
          const candidateScripts = [
            path.resolve(process.cwd(), "scripts/start-bridge-windows.sh"),
            path.resolve(process.cwd(), "../../scripts/start-bridge-windows.sh"),
            "/home/rafael/dev-rafael/connexto-proxy-cli-llms/scripts/start-bridge-windows.sh",
          ];
          const script = candidateScripts.find((s) => fs.existsSync(s));
          if (script) {
            spawn("bash", [script], { detached: true, stdio: "ignore" }).unref();
            return true;
          }
        }
      }
    } catch {
      // Ignore background auto-start errors
    }
    return false;
  }
}

