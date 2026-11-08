import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { BrowserSessionManager } from "./session-manager.js";
import { AuthStateMonitor } from "./auth-monitor.js";
import { validateTargetUrl, InvalidTargetUrlError } from "./target-validator.js";
import {
  SessionLimitError,
  SessionNotFoundError,
  SessionOwnershipError,
  type BrowserSession,
} from "./types.js";

export interface BridgeServerOptions {
  readonly sessionManager?: BrowserSessionManager;
  readonly authMonitor?: AuthStateMonitor;
  readonly bridgeToken?: string;
  readonly port?: number;
  readonly host?: string;
}

interface CreateSessionInput {
  readonly id?: string;
  readonly principalId: string;
  readonly target: string;
  readonly targetUrl?: string;
  readonly ttlMs?: number;
  readonly headless?: boolean;
  readonly persistentProfile?: boolean;
}

interface ValidationSuccess<T> {
  readonly success: true;
  readonly data: T;
}

interface ValidationFailure {
  readonly success: false;
  readonly error: {
    readonly issues: ReadonlyArray<{ readonly message: string }>;
  };
}

type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function parseCreateSession(input: unknown): ValidationResult<CreateSessionInput> {
  if (typeof input !== "object" || input === null) {
    return {
      success: false,
      error: { issues: [{ message: "Request body must be a JSON object" }] },
    };
  }

  const obj = input as Record<string, unknown>;
  const issues: Array<{ message: string }> = [];

  if (typeof obj.principalId !== "string" || obj.principalId.trim().length === 0) {
    issues.push({ message: "principalId is required" });
  }

  if (typeof obj.target !== "string" || obj.target.trim().length === 0) {
    issues.push({ message: "target is required" });
  }

  if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id.trim().length === 0)) {
    issues.push({ message: "id must be a string" });
  }

  if (obj.targetUrl !== undefined && typeof obj.targetUrl !== "string") {
    issues.push({ message: "targetUrl must be a string" });
  }

  if (
    obj.ttlMs !== undefined &&
    (typeof obj.ttlMs !== "number" || !Number.isInteger(obj.ttlMs) || obj.ttlMs <= 0)
  ) {
    issues.push({ message: "ttlMs must be a positive integer" });
  }

  if (obj.headless !== undefined && typeof obj.headless !== "boolean") {
    issues.push({ message: "headless must be a boolean" });
  }

  if (obj.persistentProfile !== undefined && typeof obj.persistentProfile !== "boolean") {
    issues.push({ message: "persistentProfile must be a boolean" });
  }

  if (issues.length > 0) {
    return { success: false, error: { issues } };
  }

  return {
    success: true,
    data: {
      id: obj.id as string | undefined,
      principalId: obj.principalId as string,
      target: obj.target as string,
      targetUrl: obj.targetUrl as string | undefined,
      ttlMs: obj.ttlMs as number | undefined,
      headless: obj.headless as boolean | undefined,
      persistentProfile: obj.persistentProfile as boolean | undefined,
    },
  };
}

function timingSafeMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.length === 0 ? ({} as T) : (JSON.parse(raw) as T));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

export function createBridgeServer(options: BridgeServerOptions = {}): {
  server: http.Server;
  sessionManager: BrowserSessionManager;
  authMonitor: AuthStateMonitor;
} {
  const sessionManager = options.sessionManager ?? new BrowserSessionManager();
  const authMonitor = options.authMonitor ?? new AuthStateMonitor();
  const bridgeToken = options.bridgeToken ?? process.env.BROWSER_BRIDGE_TOKEN ?? "stage3-secure-token-xyz";

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      // Health check endpoint (no auth required)
      if (pathname === "/health" && method === "GET") {
        sendJson(res, 200, {
          status: "ok",
          activeSessions: sessionManager.activeSessionsCount,
          platform: process.platform,
          uptime: process.uptime(),
        });
        return;
      }

      // Check authentication for internal routes
      if (pathname.startsWith("/internal")) {
        const authHeader = req.headers.authorization;
        const bridgeHeader = req.headers["x-bridge-token"];

        let token: string | undefined;
        if (typeof bridgeHeader === "string") {
          token = bridgeHeader.trim();
        } else if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
          token = authHeader.slice(7).trim();
        }

        if (!token || !timingSafeMatch(token, bridgeToken)) {
          sendJson(res, 401, {
            error: {
              code: "unauthorized",
              message: "Invalid or missing bridge authentication token",
            },
          });
          return;
        }
      }

      // GET /internal/browser/sessions - List sessions
      if (pathname === "/internal/browser/sessions" && method === "GET") {
        const principalId = (
          (url.searchParams.get("principalId") ?? undefined) ??
          (typeof req.headers["x-principal-id"] === "string" ? req.headers["x-principal-id"] : undefined)
        )?.trim();
        const list = sessionManager.listSessions(principalId);
        sendJson(res, 200, {
          sessions: list.map((s) => ({
            sessionId: s.id,
            principalId: s.principalId,
            target: s.target,
            status: s.status,
            connected: s.status !== "disconnected",
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            expiresAt: s.expiresAt,
          })),
        });
        return;
      }

      // POST /internal/browser/sessions - Create session
      if (pathname === "/internal/browser/sessions" && method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: { code: "invalid_json", message: (err as Error).message } });
          return;
        }

        const parseResult = parseCreateSession(body);
        if (!parseResult.success) {
          sendJson(res, 400, {
            error: {
              code: "invalid_request",
              message: parseResult.error.issues.map((i) => i.message).join(", "),
            },
          });
          return;
        }

        const { id, principalId, target, targetUrl, ttlMs, headless, persistentProfile } = parseResult.data;

        // SSRF protection
        if (targetUrl && targetUrl !== "about:blank") {
          try {
            validateTargetUrl(targetUrl);
          } catch (err) {
            if (err instanceof InvalidTargetUrlError) {
              sendJson(res, 400, {
                error: { code: "ssrf_violation", message: err.message },
              });
              return;
            }
            throw err;
          }
        }

        try {
          const session = await sessionManager.createSession({
            id,
            principalId,
            target,
            targetUrl,
            ttlMs,
            headless,
            persistentProfile,
          });

          // Attach AuthMonitor
          try {
            await authMonitor.attachSession(session.id, session.cdpPort, targetUrl);
          } catch (attachErr) {
            console.warn(`[AuthMonitor] Warning: Attach failed for session ${session.id}:`, attachErr);
          }

          // Safe DTO response (never leaks internal CDP ports or raw ws url)
          sendJson(res, 201, {
            sessionId: session.id,
            principalId: session.principalId,
            target: session.target,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            expiresAt: session.expiresAt,
          });
        } catch (err) {
          if (err instanceof SessionLimitError) {
            sendJson(res, 429, { error: { code: "session_limit_exceeded", message: err.message } });
            return;
          }
          if (err instanceof SessionOwnershipError) {
            sendJson(res, 403, { error: { code: "forbidden", message: err.message } });
            return;
          }
          sendJson(res, 500, {
            error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) },
          });
        }
        return;
      }

      // Match /internal/browser/sessions/:id/execute
      const execMatch = pathname.match(/^\/internal\/browser\/sessions\/([^/]+)\/execute$/);
      if (execMatch && method === "POST") {
        const sessionId = decodeURIComponent(execMatch[1] ?? "");
        let body: { principalId?: string; action?: "evaluate" | "navigate"; param?: string };
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: { code: "invalid_json", message: (err as Error).message } });
          return;
        }

        const principalId = body.principalId?.trim();
        if (!principalId) {
          sendJson(res, 400, { error: { code: "missing_principal", message: "principalId is required" } });
          return;
        }

        if (body.action !== "evaluate" && body.action !== "navigate") {
          sendJson(res, 400, { error: { code: "invalid_action", message: "action must be 'evaluate' or 'navigate'" } });
          return;
        }

        if (typeof body.param !== "string" || body.param.trim().length === 0) {
          sendJson(res, 400, { error: { code: "missing_param", message: "param is required" } });
          return;
        }

        try {
          // Validate session ownership
          sessionManager.getSession(sessionId, principalId);
          const execRes = await authMonitor.executeSessionAction(sessionId, body.action, body.param);
          if (!execRes.success) {
            sendJson(res, 500, { error: { code: "execution_failed", message: execRes.error ?? "Action failed" } });
            return;
          }
          sendJson(res, 200, { success: true, result: execRes.result });
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            sendJson(res, 404, { error: { code: "not_found", message: err.message } });
            return;
          }
          if (err instanceof SessionOwnershipError) {
            sendJson(res, 403, { error: { code: "forbidden", message: err.message } });
            return;
          }
          if (err instanceof InvalidTargetUrlError) {
            sendJson(res, 400, { error: { code: "ssrf_violation", message: err.message } });
            return;
          }
          sendJson(res, 500, { error: { code: "internal_error", message: (err as Error).message } });
        }
        return;
      }

      // Match /internal/browser/sessions/:id
      const sessionMatch = pathname.match(/^\/internal\/browser\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] ?? "");

        const principalId = (
          (url.searchParams.get("principalId") ?? undefined) ??
          (typeof req.headers["x-principal-id"] === "string" ? req.headers["x-principal-id"] : undefined)
        )?.trim();

        if (!principalId) {
          sendJson(res, 400, {
            error: {
              code: "missing_principal",
              message: "principalId query param or X-Principal-Id header is required",
            },
          });
          return;
        }

        // GET session
        if (method === "GET") {
          let session: BrowserSession;
          try {
            session = sessionManager.getSession(sessionId, principalId);
          } catch (err) {
            if (err instanceof SessionNotFoundError) {
              sendJson(res, 404, { error: { code: "not_found", message: err.message } });
              return;
            }
            if (err instanceof SessionOwnershipError) {
              sendJson(res, 403, { error: { code: "forbidden", message: err.message } });
              return;
            }
            throw err;
          }

          // Check auth status
          let details: string | undefined;
          let currentUrl: string | undefined;
          if (session.status === "waiting_for_login") {
            const authResult = await authMonitor.checkSessionAuth(session.id, session.target);
            currentUrl = authResult.currentUrl;
            details = authResult.details;

            if (authResult.status === "authenticated") {
              session.status = "authenticated";
              session.updatedAt = new Date().toISOString();
            }
          }

          sendJson(res, 200, {
            sessionId: session.id,
            principalId: session.principalId,
            target: session.target,
            status: session.status,
            connected: session.status !== "disconnected",
            currentUrl,
            details,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            expiresAt: session.expiresAt,
          });
          return;
        }

        // DELETE session
        if (method === "DELETE") {
          try {
            await authMonitor.detachSession(sessionId);
            await sessionManager.closeSession(sessionId, principalId);
            res.writeHead(204);
            res.end();
          } catch (err) {
            if (err instanceof SessionOwnershipError) {
              sendJson(res, 403, { error: { code: "forbidden", message: err.message } });
              return;
            }
            sendJson(res, 500, {
              error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) },
            });
          }
          return;
        }
      }

      // Not found
      sendJson(res, 404, { error: { code: "route_not_found", message: `Not Found: ${method} ${pathname}` } });
    } catch (unhandled) {
      sendJson(res, 500, {
        error: { code: "unhandled_error", message: unhandled instanceof Error ? unhandled.message : String(unhandled) },
      });
    }
  })();
});

  return { server, sessionManager, authMonitor };
}

export function startBridgeServer(options: BridgeServerOptions = {}): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const { server, sessionManager, authMonitor } = createBridgeServer(options);
  const port = options.port ?? (process.env.BROWSER_BRIDGE_PORT ? Number.parseInt(process.env.BROWSER_BRIDGE_PORT, 10) : 4318);
  const host = options.host ?? "0.0.0.0";

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`[HostBrowserBridge] Server listening on http://${host}:${port}`);
      resolve({
        server,
        port,
        close: async () => {
          await authMonitor.detachSession("all");
          await sessionManager.closeAll();
          return new Promise((resClose) => {
            server.close(() => resClose());
          });
        },
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}
