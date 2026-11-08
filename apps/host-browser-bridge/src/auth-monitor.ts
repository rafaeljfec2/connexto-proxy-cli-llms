import http from "node:http";
import { validateTargetUrl, InvalidTargetUrlError } from "./target-validator.js";
import type { BrowserAuthStatus } from "./types.js";

export interface AuthDetectionResult {
  readonly status: BrowserAuthStatus;
  readonly currentUrl?: string;
  readonly details?: string;
}

export interface CdpPageInfo {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface MonitoredBrowserSession {
  readonly sessionId: string;
  readonly cdpPort: number;
  ws?: WebSocket;
  pageWsUrl?: string;
  close(): Promise<void>;
}

export class AuthStateMonitor {
  private readonly monitoredSessions = new Map<string, MonitoredBrowserSession>();
  private readonly pendingCdpRequests = new Map<number, (data: unknown) => void>();
  private nextCdpId = 1000;

  public async attachSession(
    sessionId: string,
    cdpPort: number,
    initialTargetUrl?: string,
  ): Promise<MonitoredBrowserSession> {
    const existing = this.monitoredSessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const pages = await this.listPages(cdpPort);
    const targetPage = pages.find((p) => p.type === "page") ?? pages[0];
    const pageWsUrl = targetPage?.webSocketDebuggerUrl;

    const monitored: MonitoredBrowserSession = {
      sessionId,
      cdpPort,
      pageWsUrl,
      close: () => {
        if (monitored.ws && monitored.ws.readyState === WebSocket.OPEN) {
          monitored.ws.close();
        }
        this.monitoredSessions.delete(sessionId);
        return Promise.resolve();
      },
    };

    if (pageWsUrl) {
      // Connect native WebSocket for CDP commands and runtime SSRF protection
      try {
        const ws = new WebSocket(pageWsUrl);
        monitored.ws = ws;

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => resolve(), 3000);
          ws.onopen = () => {
            clearTimeout(timeout);
            // Enable Network and Page domains
            ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
            ws.send(JSON.stringify({ id: 2, method: "Page.enable" }));
            ws.send(JSON.stringify({ id: 3, method: "Runtime.enable" }));

            // Setup runtime request interception for SSRF blocking
            ws.send(JSON.stringify({ id: 4, method: "Fetch.enable" }));

            if (initialTargetUrl && initialTargetUrl !== "about:blank") {
              validateTargetUrl(initialTargetUrl);
              ws.send(
                JSON.stringify({
                  id: 5,
                  method: "Page.navigate",
                  params: { url: initialTargetUrl },
                }),
              );
            }
            resolve();
          };
          ws.onerror = (event) => {
            clearTimeout(timeout);
            const msg =
              event instanceof Error
                ? event.message
                : "WebSocket error connecting to CDP";
            reject(event instanceof Error ? event : new Error(msg));
          };
          ws.onmessage = (event) => {
            this.handleCdpMessage(ws, event.data);
          };
        });
      } catch (wsErr) {
        console.warn(`[AuthMonitor] Warning: WebSocket attach to CDP for session ${sessionId} failed:`, wsErr);
      }
    }

    this.monitoredSessions.set(sessionId, monitored);
    return monitored;
  }

  private handleCdpMessage(ws: WebSocket, rawData: unknown): void {
    let text: string | undefined;
    if (typeof rawData === "string") {
      text = rawData;
    } else if (Buffer.isBuffer(rawData)) {
      text = rawData.toString("utf8");
    } else if (rawData instanceof ArrayBuffer) {
      text = Buffer.from(rawData).toString("utf8");
    }
    if (!text) return;

    try {
      const msg = JSON.parse(text) as {
        id?: number;
        method?: string;
        params?: { requestId?: string; request?: { url?: string } };
        result?: unknown;
        error?: { message?: string };
      };

      if (typeof msg.id === "number" && this.pendingCdpRequests.has(msg.id)) {
        const cb = this.pendingCdpRequests.get(msg.id);
        this.pendingCdpRequests.delete(msg.id);
        cb?.(msg);
        return;
      }

      // Intercept secondary requests and redirects to prevent SSRF
      if (msg.method === "Fetch.requestPaused" && msg.params?.requestId) {
        const reqUrl = msg.params.request?.url;
        const requestId = msg.params.requestId;

        if (!reqUrl || reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || reqUrl === "about:blank") {
          ws.send(
            JSON.stringify({
              id: ++this.nextCdpId,
              method: "Fetch.continueRequest",
              params: { requestId },
            }),
          );
          return;
        }

        try {
          validateTargetUrl(reqUrl);
          ws.send(
            JSON.stringify({
              id: ++this.nextCdpId,
              method: "Fetch.continueRequest",
              params: { requestId },
            }),
          );
        } catch (err) {
          if (err instanceof InvalidTargetUrlError) {
            console.warn(`[SSRF Blocked] Sub-request aborted for ${reqUrl}: ${err.message}`);
            ws.send(
              JSON.stringify({
                id: ++this.nextCdpId,
                method: "Fetch.failRequest",
                params: { requestId, errorReason: "AccessDenied" },
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                id: ++this.nextCdpId,
                method: "Fetch.continueRequest",
                params: { requestId },
              }),
            );
          }
        }
      }
    } catch {
      // Ignore parse errors on high-frequency CDP events
    }
  }

  public async checkSessionAuth(
    sessionId: string,
    target: string,
  ): Promise<AuthDetectionResult> {
    const session = this.monitoredSessions.get(sessionId);
    if (!session) {
      return { status: "waiting_for_login", details: "Session not attached" };
    }

    try {
      const pages = await this.listPages(session.cdpPort);
      const activePage = pages.find((p) => p.type === "page") ?? pages[0];
      const currentUrl = activePage?.url ?? "";
      const pageTitle = activePage?.title ?? "";

      // Check if page contains challenge
      if (/just a moment|security check|cloudflare|turnstile/i.test(pageTitle)) {
        return {
          status: "waiting_for_login",
          currentUrl,
          details: "Security challenge detected - awaiting manual user completion",
        };
      }

      if (target.toLowerCase() === "cursor") {
        return this.checkCursorAuth(session, currentUrl);
      }

      // Default strategy
      return { status: "waiting_for_login", currentUrl };
    } catch (err) {
      return {
        status: "waiting_for_login",
        details: `Transient check error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async checkCursorAuth(
    session: MonitoredBrowserSession,
    currentUrl: string,
  ): Promise<AuthDetectionResult> {
    const isLoginUrl = /(?:cursor\.(?:com|sh)|auth\.x\.ai|grok\.com)\/(?:login|sign-in|set-cookie)/i.test(currentUrl);
    if (isLoginUrl) {
      return { status: "waiting_for_login", currentUrl, details: "User on login page" };
    }

    // Query cookies via CDP
    const cookies = await this.queryCdpCookies(session.cdpPort, session.pageWsUrl);
    const hasAuthCookie = cookies.some(
      (c) =>
        (c.name === "WorkosCursorSessionToken" ||
          c.name === "__session" ||
          c.name === "sso" ||
          c.name.includes("cursor_auth") ||
          c.name.includes("connect.sid")) &&
        c.value.length > 5,
    );

    const isDashboard = /(?:cursor\.com|grok\.com)\/dashboard/i.test(currentUrl);

    if (hasAuthCookie || (isDashboard && !isLoginUrl)) {
      return {
        status: "authenticated",
        currentUrl,
        details: "Cursor/Grok session authenticated with confirmed session cookies",
      };
    }

    return { status: "waiting_for_login", currentUrl, details: "Awaiting authentication" };
  }

  private listPages(port: number): Promise<CdpPageInfo[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/json/list", timeout: 2000 },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            try {
              const pages = JSON.parse(data) as CdpPageInfo[];
              resolve(pages);
            } catch (err) {
              reject(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          });
        },
      );
      req.on("error", (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout listing CDP pages"));
      });
    });
  }

  private async queryCdpCookies(
    port: number,
    pageWsUrl?: string,
  ): Promise<Array<{ name: string; value: string; domain: string }>> {
    if (!pageWsUrl) {
      return [];
    }

    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(pageWsUrl);
        const timeout = setTimeout(() => {
          ws.close();
          resolve([]);
        }, 2000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 100, method: "Network.getCookies" }));
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const data = JSON.parse(event.data) as {
              id?: number;
              result?: { cookies?: Array<{ name: string; value: string; domain: string }> };
            };
            if (data.id === 100) {
              clearTimeout(timeout);
              ws.close();
              resolve(data.result?.cookies ?? []);
            }
          } catch {
            clearTimeout(timeout);
            ws.close();
            resolve([]);
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          resolve([]);
        };
      } catch {
        resolve([]);
      }
    });
  }

  public async detachSession(sessionId: string): Promise<void> {
    const session = this.monitoredSessions.get(sessionId);
    if (session) {
      await session.close();
    }
  }

  public async executeSessionAction(
    sessionId: string,
    action: "evaluate" | "navigate",
    param: string,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const session = this.monitoredSessions.get(sessionId);
    if (!session) {
      return { success: false, error: "Session not found in monitor" };
    }

    if (action === "navigate") {
      validateTargetUrl(param);
    }

    // Always obtain the freshest page WebSocket URL to handle navigations
    let targetWsUrl = session.pageWsUrl;
    try {
      const pages = await this.listPages(session.cdpPort);
      const active = pages.find((p) => p.type === "page") ?? pages[0];
      if (active?.webSocketDebuggerUrl) {
        targetWsUrl = active.webSocketDebuggerUrl;
      }
    } catch {
      // fallback to stored ws url
    }

    if (!targetWsUrl) {
      return { success: false, error: "No target WebSocket URL found" };
    }

    const reqId = ++this.nextCdpId;
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(targetWsUrl);
      } catch (err) {
        return resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve({ success: false, error: "CDP execution timeout" });
      }, 15000);

      ws.addEventListener("open", () => {
        if (action === "navigate") {
          ws.send(
            JSON.stringify({
              id: reqId,
              method: "Page.navigate",
              params: { url: param },
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              id: reqId,
              method: "Runtime.evaluate",
              params: {
                expression: param,
                awaitPromise: true,
                returnByValue: true,
              },
            }),
          );
        }
      });

      ws.addEventListener("message", (event) => {
        let text: string | undefined;
        if (typeof event.data === "string") {
          text = event.data;
        } else if (Buffer.isBuffer(event.data)) {
          text = event.data.toString("utf8");
        } else if (event.data instanceof ArrayBuffer) {
          text = Buffer.from(event.data).toString("utf8");
        }
        if (!text) return;

        try {
          const data = JSON.parse(text) as {
            id?: number;
            result?: { result?: { value?: unknown }; frameId?: string };
            error?: { message?: string };
          };
          if (data.id === reqId) {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              // ignore
            }
            if (data.error) {
              resolve({ success: false, error: data.error.message });
            } else {
              resolve({
                success: true,
                result: data.result?.result?.value ?? data.result,
              });
            }
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve({ success: false, error: "WebSocket connection error" });
      });
    });
  }
}
