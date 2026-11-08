import crypto from "node:crypto";
import { AccountLockMap } from "./account-lock.js";
import {
  BrowserUnavailableError,
  ChallengeRequiredError,
  CollectionFailedError,
  PlaywrightBrowserPool,
  SessionExpiredError,
  type PlaywrightBrowserPool as BrowserPoolType,
} from "./playwright-browser.js";
import {
  HostBrowserBridgeClient,
  BridgeSessionNotFoundError,
} from "./host-bridge-client.js";
import {
  isCollectableSessionRecord,
  isUsableStorageState,
} from "./session-validation.js";
import { CursorUsageSessionStore } from "./session-store.js";
import type {
  CursorUsageAuthOperation,
  CursorUsageAuthStartResult,
  CursorUsageAuthStatusResult,
  CursorUsageCollectResult,
  CursorUsageServiceOptions,
} from "./types.js";
import {
  DEFAULT_COLLECT_DASHBOARD_URL,
  DEFAULT_USAGE_ANALYTICS_SUFFIX,
  DEFAULT_USAGE_STATUS_SUFFIX,
  normalizeCursorUsagePayload,
  resolveCollectApiUrl,
} from "./usage-normalize.js";

const DEFAULT_LOGIN = "https://cursor.com/dashboard";
const DEFAULT_USAGE_PATTERN =
  /usage-summary|get-current-period|get-filtered-usage|usage-status|get-user-analytics/i;
/** OAuth lands on cursor.com; usage APIs use cursor.com session cookies (not grok.com). */
const DEFAULT_AUTHENTICATED_URL_PATTERN =
  /(^https?:\/\/)?(?:([^/]+\.)?cursor\.com\/(dashboard|settings|agents)|grok\.com\/dashboard)(\/?|$|\?)/i;
const DEFAULT_COLLECT_READY_URL_PATTERN = DEFAULT_AUTHENTICATED_URL_PATTERN;

export class CursorUsageService {
  private readonly sessionStore: CursorUsageSessionStore;
  private readonly browserPool: BrowserPoolType;
  private readonly locks = new AccountLockMap();
  private readonly authOperations = new Map<string, CursorUsageAuthOperation>();
  private readonly liveContexts = new Map<
    string,
    import("playwright-core").BrowserContext
  >();
  private readonly authOperationTtlMs: number;
  private readonly collectTimeoutMs: number;
  private readonly loginUrl: string;
  private readonly collectDashboardUrl: string;
  private readonly usageStatusUrl?: string;
  private readonly usageAnalyticsUrl?: string;
  private readonly usageUrlPattern: RegExp;
  private readonly authenticatedUrlPattern: RegExp;
  private readonly collectReadyUrlPattern: RegExp;
  private readonly interactionUrlBase: string;
  private readonly authHeadless: boolean;
  private readonly hostBridgeClient?: HostBrowserBridgeClient;
  private readonly now: () => number;

  constructor(options: CursorUsageServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sessionStore = new CursorUsageSessionStore({
      maxSessions: options.maxSessions,
      ttlMs: options.sessionTtlMs,
      store: options.store,
      now: this.now,
    });
    this.browserPool =
      options.browserPool ??
      new PlaywrightBrowserPool({
        chromiumExecutablePath: options.chromiumExecutablePath,
        cdpEndpoint: options.cdpEndpoint,
        cdpFallback: options.cdpFallback,
        chromiumNoSandbox: options.chromiumNoSandbox,
        collectHeadless: options.collectHeadless,
        authHeadless: options.authHeadless,
        authUserDataDirRoot: options.authUserDataDirRoot,
        authViewportWidth: options.authViewportWidth,
        authViewportHeight: options.authViewportHeight,
      });
    this.authOperationTtlMs = options.authOperationTtlMs ?? 30 * 60_000;
    this.collectTimeoutMs = options.collectTimeoutMs ?? 60_000;
    this.loginUrl = options.loginUrl ?? DEFAULT_LOGIN;
    this.collectDashboardUrl = options.dashboardUrl ?? DEFAULT_COLLECT_DASHBOARD_URL;
    this.usageStatusUrl = options.usageStatusUrl;
    this.usageAnalyticsUrl = options.usageAnalyticsUrl;
    this.usageUrlPattern = options.usageResponseUrlPattern ?? DEFAULT_USAGE_PATTERN;
    this.authenticatedUrlPattern =
      options.authenticatedUrlPattern ?? DEFAULT_AUTHENTICATED_URL_PATTERN;
    this.collectReadyUrlPattern =
      options.collectReadyUrlPattern ?? DEFAULT_COLLECT_READY_URL_PATTERN;
    this.interactionUrlBase = options.interactionUrlBase ?? "";
    this.authHeadless = options.authHeadless !== false;
    if (options.hostBridgeClient) {
      this.hostBridgeClient = options.hostBridgeClient;
    } else if (options.hostBridgeUrl ?? process.env.BROWSER_BRIDGE_URL) {
      this.hostBridgeClient = new HostBrowserBridgeClient({
        baseUrl: options.hostBridgeUrl,
        token: options.hostBridgeToken,
      });
    }
  }

  public async collectUsage(accountId: string): Promise<CursorUsageCollectResult> {
    return this.locks.run(accountId, async () => {
      if (this.hostBridgeClient) {
        return this.collectUsageViaBridge(accountId);
      }

      const session = await this.sessionStore.resolve(accountId);
      if (this.browserPool.hasActiveAuthForAccount(accountId)) {
        if (
          session !== undefined &&
          session.status === "authenticated" &&
          isCollectableSessionRecord(
            session,
            this.browserPool.hasAuthProfile(accountId),
          )
        ) {
          await this.browserPool.closeAuthSessionsForAccount(accountId);
        } else {
          return {
            status: "authentication_pending",
            provider: "cursor",
            accountId,
          };
        }
      }
      const profilePresent = this.browserPool.hasAuthProfile(accountId);
      if (session === undefined || session.status !== "authenticated") {
        if (!profilePresent) {
          return {
            status: "authentication_required",
            provider: "cursor",
            accountId,
          };
        }
      } else if (!isCollectableSessionRecord(session, profilePresent)) {
        await this.sessionStore.delete(accountId);
        return {
          status: "authentication_required",
          provider: "cursor",
          accountId,
        };
      }

      try {
        const restoredState = session?.storageState ?? { cookies: [], origins: [] };
        const context = await this.browserPool.restoreAuthenticatedSession(
          accountId,
          restoredState,
        );
        await this.browserPool.primeCollectDashboard({
          context,
          dashboardUrl: this.collectDashboardUrl,
          urlPattern: this.usageUrlPattern,
          timeoutMs: this.collectTimeoutMs,
        });
        let usage: Record<string, unknown>;
        let collectionMethod: string;
        try {
          usage = await this.collectUsageViaApi(context);
          collectionMethod = "dashboard_api";
        } catch (apiError) {
          if (apiError instanceof SessionExpiredError) {
            throw apiError;
          }
          const raw = await this.browserPool.waitForUsageJson({
            context,
            dashboardUrl: this.collectDashboardUrl,
            urlPattern: this.usageUrlPattern,
            timeoutMs: this.collectTimeoutMs,
          });
          usage = normalizeUsagePayloadFromNetwork(raw);
          collectionMethod = "browser_network";
        }
        const storageState = await context.storageState();
        await context.close();
        const persistTarget =
          session ??
          ({
            accountId,
            status: "authenticated",
            touchedAt: this.now(),
          } as const);
        await this.sessionStore
          .setPersisted(
            {
              ...persistTarget,
              status: "authenticated",
              storageState,
            },
            {
              allowAuthProfileFallback:
                profilePresent && !isUsableStorageState(storageState),
            },
          )
          .catch(() => undefined);
        return {
          status: "available",
          provider: "cursor",
          accountId,
          collectedAt: new Date(this.now()).toISOString(),
          usage,
          metadata: {
            source: "cursor_dashboard",
            collectionMethod,
          },
        };
      } catch (error) {
        if (error instanceof ChallengeRequiredError) {
          return { status: "challenge_required", provider: "cursor", accountId };
        }
        if (error instanceof SessionExpiredError) {
          await this.sessionStore.delete(accountId);
          return { status: "session_expired", provider: "cursor", accountId };
        }
        if (error instanceof BrowserUnavailableError) {
          return { status: "browser_unavailable", provider: "cursor", accountId };
        }
        if (error instanceof CollectionFailedError) {
          return { status: "collection_failed", provider: "cursor", accountId };
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout/i.test(message)) {
          return { status: "timeout", provider: "cursor", accountId };
        }
        return { status: "collection_failed", provider: "cursor", accountId };
      }
    });
  }

  private async collectUsageViaBridge(
    accountId: string,
  ): Promise<CursorUsageCollectResult> {
    if (!this.hostBridgeClient) {
      return { status: "collection_failed", provider: "cursor", accountId };
    }

    let createdForCollect = false;
    let activeSessionId: string | undefined;

    try {
      const sessions = await this.hostBridgeClient.listSessions(accountId);
      let active = sessions.find(
        (s) =>
          s.connected !== false &&
          (s.status === "authenticated" || s.status === "waiting_for_login"),
      );

      if (!active) {
        // Automatically launch invisible background session reusing the persistent profile
        try {
          const launched = await this.hostBridgeClient.createSession({
            principalId: accountId,
            target: "cursor",
            targetUrl: "https://grok.com/dashboard",
            headless: true, // Invisible background collect - no windows pop up!
          });
          active = launched;
          createdForCollect = true;
          activeSessionId = launched.sessionId;
          // Short pause for page and session cookies to load
          await new Promise((resolve) => setTimeout(resolve, 2500));
        } catch {
          return { status: "authentication_required", provider: "cursor", accountId };
        }
      } else {
        activeSessionId = active.sessionId;
      }

      if (!active) {
        return { status: "authentication_required", provider: "cursor", accountId };
      }

      if (active.status === "waiting_for_login") {
        const check = await this.hostBridgeClient.getSession(
          active.sessionId,
          accountId,
        );
        if (check.status !== "authenticated") {
          return { status: "authentication_pending", provider: "cursor", accountId };
        }
      }

      const evalScript = `
        (async () => {
          try {
            const fetchJson = async (url, method = "GET") => {
              try {
                const res = await fetch(url, {
                  method,
                  credentials: "include",
                  headers: { "Accept": "application/json" }
                });
                if (res.ok) {
                  const data = await res.json();
                  if (data && typeof data === "object") return data;
                }
              } catch {}
              return null;
            };

            // 1. Fetch usage status
            let usageStatus = null;
            const statusEndpoints = [
              "/dashboard/api/dashboard/v2/usage-status?scope=user",
              "/api/usage-status?scope=user",
              "/dashboard/api/usage-status?scope=user",
              "https://grok.com/dashboard/api/dashboard/v2/usage-status?scope=user",
              "/api/usage-summary",
              "https://cursor.com/api/usage-summary",
              "/api/dashboard/get-current-period-usage"
            ];
            for (const ep of statusEndpoints) {
              usageStatus = await fetchJson(ep, ep.includes("get-current-period-usage") ? "POST" : "GET");
              if (usageStatus && Object.keys(usageStatus).length > 0) break;
            }

            // 2. Fetch prepaid billing (Requires POST)
            let prepaid = null;
            const prepaidEndpoints = [
              "/dashboard/api/dashboard/get-user-prepaid-billing",
              "/api/dashboard/get-user-prepaid-billing",
              "https://grok.com/dashboard/api/dashboard/get-user-prepaid-billing"
            ];
            for (const ep of prepaidEndpoints) {
              prepaid = await fetchJson(ep, "POST");
              if (!prepaid) {
                prepaid = await fetchJson(ep, "GET");
              }
              if (prepaid && !prepaid.error && Object.keys(prepaid).length > 0) break;
            }

            // 3. Fetch analytics
            let analytics = null;
            const analyticsEndpoints = [
              "/dashboard/api/dashboard/get-user-analytics",
              "/api/dashboard/get-user-analytics",
              "/api/dashboard/get-current-period-usage"
            ];
            for (const ep of analyticsEndpoints) {
              analytics = await fetchJson(ep, "POST");
              if (!analytics) {
                analytics = await fetchJson(ep, "GET");
              }
              if (analytics && Object.keys(analytics).length > 0) break;
            }

            if (usageStatus || prepaid || analytics) {
              return {
                ok: true,
                data: {
                  usageStatus: usageStatus ?? {},
                  prepaid: prepaid ?? undefined,
                  analytics: analytics ?? undefined,
                }
              };
            }
          } catch (e) {
            return { ok: false, error: e.message };
          }
          return { ok: false, error: "no_matched_endpoint" };
        })()
      `;

      const evalResult = (await this.hostBridgeClient.executeInSession(
        active.sessionId,
        accountId,
        "evaluate",
        evalScript,
      )) as { ok?: boolean; data?: unknown; error?: string } | undefined;

      if (evalResult && evalResult.ok && evalResult.data) {
        const usage = normalizeCursorUsagePayload(evalResult.data);
        await this.sessionStore
          .setPersisted(
            {
              accountId,
              status: "authenticated",
              touchedAt: this.now(),
              authProfileBacked: true,
            },
            { allowAuthProfileFallback: true },
          )
          .catch(() => undefined);

        return {
          status: "available",
          provider: "cursor",
          accountId,
          collectedAt: new Date(this.now()).toISOString(),
          usage,
          metadata: {
            source: "cursor_dashboard",
            collectionMethod: "host_browser_bridge",
          },
        };
      }

      return { status: "collection_failed", provider: "cursor", accountId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timeout/i.test(message)) {
        return { status: "timeout", provider: "cursor", accountId };
      }
      return { status: "collection_failed", provider: "cursor", accountId };
    } finally {
      if (createdForCollect && activeSessionId) {
        await this.hostBridgeClient
          .closeSession(activeSessionId, accountId)
          .catch(() => undefined);
      }
    }
  }

  public async startAuth(accountId: string): Promise<CursorUsageAuthStartResult> {
    return this.locks.run(accountId, async () => {
      this.purgeExpiredAuthOperations();
      const sessionId = crypto.randomUUID();
      const expiresAt = this.now() + this.authOperationTtlMs;
      const interactionUrl = `${this.interactionUrlBase}/v1/providers/cursor/auth/${sessionId}/interaction`;

      try {
        if (this.hostBridgeClient) {
          await this.hostBridgeClient.createSession({
            sessionId,
            principalId: accountId,
            target: "cursor",
            targetUrl: this.loginUrl,
            headless: false,
          });
        } else {
          await this.browserPool.openAuthSession(sessionId, accountId, this.loginUrl);
        }
      } catch (error) {
        if (error instanceof BrowserUnavailableError) {
          throw error;
        }
        throw new BrowserUnavailableError(error);
      }

      const operation: CursorUsageAuthOperation = {
        sessionId,
        accountId,
        status: "authentication_pending",
        createdAt: this.now(),
        expiresAt,
        interactionUrl,
      };
      this.authOperations.set(sessionId, operation);

      return {
        status: "authentication_pending",
        sessionId,
        expiresAt: new Date(expiresAt).toISOString(),
        interactionUrl,
        browserMode: this.hostBridgeClient
          ? "headed"
          : this.authHeadless
            ? "headless"
            : "headed",
      };
    });
  }

  public async getAuthStatus(sessionId: string): Promise<CursorUsageAuthStatusResult> {
    this.purgeExpiredAuthOperations();
    const operation = this.authOperations.get(sessionId);
    if (operation === undefined) {
      return {
        sessionId,
        accountId: "",
        status: "expired",
        expiresAt: new Date(0).toISOString(),
      };
    }

    if (operation.status === "authentication_pending") {
      if (this.hostBridgeClient) {
        try {
          const remote = await this.hostBridgeClient.getSession(
            sessionId,
            operation.accountId,
          );
          if (remote.status === "authenticated") {
            operation.status = "authenticated";
            await this.sessionStore.setPersisted(
              {
                accountId: operation.accountId,
                status: "authenticated",
                touchedAt: this.now(),
                authProfileBacked: true,
              },
              { allowAuthProfileFallback: true },
            );
          } else if (remote.status === "failed") {
            operation.status = "authentication_failed";
          } else if (remote.status === "expired") {
            operation.status = "expired";
          }
          return {
            sessionId,
            accountId: operation.accountId,
            status: operation.status,
            expiresAt: new Date(operation.expiresAt).toISOString(),
          };
        } catch (bridgeErr) {
          if (bridgeErr instanceof BridgeSessionNotFoundError) {
            operation.status = "expired";
          }
        }
      }

      const live = this.browserPool.getLiveAuth(sessionId);
      if (live !== undefined) {
        const url = live.page.url();
        if (this.collectReadyUrlPattern.test(url)) {
          if (await this.browserPool.pageHasUpstreamChallenge(live.page)) {
            operation.status = "challenge_required";
            return {
              sessionId,
              accountId: operation.accountId,
              status: operation.status,
              expiresAt: new Date(operation.expiresAt).toISOString(),
            };
          }
          const storageState = await this.browserPool.captureStorageState(sessionId);
          const profileReady = this.browserPool.hasAuthProfile(operation.accountId);
          if (!isUsableStorageState(storageState) && !profileReady) {
            // Wait for OAuth cookies before promoting to authenticated.
          } else {
            try {
              const written = await this.sessionStore.setPersisted(
                {
                  accountId: operation.accountId,
                  status: "authenticated",
                  touchedAt: this.now(),
                  storageState,
                },
                { allowAuthProfileFallback: profileReady },
              );
              const resolved = written
                ? await this.sessionStore.resolve(operation.accountId)
                : undefined;
              if (
                written &&
                resolved !== undefined &&
                isCollectableSessionRecord(resolved, profileReady)
              ) {
                operation.status = "authenticated";
                try {
                  const refreshedState =
                    await this.browserPool.captureStorageState(sessionId);
                  if (isUsableStorageState(refreshedState)) {
                    await this.sessionStore.setPersisted({
                      accountId: operation.accountId,
                      status: "authenticated",
                      touchedAt: this.now(),
                      storageState: refreshedState,
                    });
                  }
                } catch {
                  // Best-effort refresh before closing headed browser.
                }
                await this.browserPool.closeAuthSession(sessionId);
              } else {
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    msg: "session_persist_failed",
                    accountId: operation.accountId,
                    reason: written
                      ? "resolve_empty_after_write"
                      : "set_persisted_rejected",
                  }),
                );
              }
            } catch (error) {
              const errno =
                error !== null &&
                typeof error === "object" &&
                "code" in error &&
                typeof (error as NodeJS.ErrnoException).code === "string"
                  ? (error as NodeJS.ErrnoException).code
                  : undefined;
              console.warn(
                JSON.stringify({
                  level: "warn",
                  msg: "session_persist_failed",
                  accountId: operation.accountId,
                  errno,
                  message: error instanceof Error ? error.message : String(error),
                }),
              );
            }
          }
        }
      }
    }

    return {
      sessionId,
      accountId: operation.accountId,
      status: operation.status,
      expiresAt: new Date(operation.expiresAt).toISOString(),
    };
  }

  public async getCollectSessionStatus(accountId: string): Promise<{
    readonly status: "authenticated" | "authentication_required";
    readonly accountId: string;
    readonly touchedAt?: string;
  }> {
    const session = await this.sessionStore.resolve(accountId);
    const profilePresent = this.browserPool.hasAuthProfile(accountId);
    if (
      session === undefined ||
      session.status !== "authenticated" ||
      !isCollectableSessionRecord(session, profilePresent)
    ) {
      if (profilePresent) {
        return {
          status: "authenticated",
          accountId,
          touchedAt: new Date(this.now()).toISOString(),
        };
      }
      return {
        status: "authentication_required",
        accountId,
      };
    }
    return {
      status: "authenticated",
      accountId,
      touchedAt: new Date(session.touchedAt).toISOString(),
    };
  }

  public getInteractionPage(sessionId: string): { url: string } | undefined {
    const live = this.browserPool.getLiveAuth(sessionId);
    if (live === undefined) {
      return undefined;
    }
    return { url: live.page.url() };
  }

  public async cancelAuth(sessionId: string): Promise<void> {
    const operation = this.authOperations.get(sessionId);
    if (this.hostBridgeClient && operation) {
      try {
        await this.hostBridgeClient.closeSession(sessionId, operation.accountId);
      } catch {
        // Best-effort remote bridge cleanup
      }
    }
    if (operation !== undefined) {
      this.authOperations.delete(sessionId);
    }
    await this.browserPool.closeAuthSession(sessionId);
  }

  public async shutdown(): Promise<void> {
    await this.browserPool.shutdown();
    for (const context of this.liveContexts.values()) {
      await context.close();
    }
    this.liveContexts.clear();
  }

  public async clearPersistedSessions(): Promise<void> {
    this.authOperations.clear();
    this.sessionStore.clearMemory();
    await this.browserPool.shutdown();
  }

  private purgeExpiredAuthOperations(): void {
    const now = this.now();
    for (const [sessionId, op] of this.authOperations) {
      if (now > op.expiresAt) {
        this.authOperations.delete(sessionId);
        void this.browserPool.closeAuthSession(sessionId);
      }
    }
  }

  private async collectUsageViaApi(
    context: import("playwright-core").BrowserContext,
  ): Promise<Record<string, unknown>> {
    const statusUrl = resolveCollectApiUrl(
      this.collectDashboardUrl,
      this.usageStatusUrl,
      DEFAULT_USAGE_STATUS_SUFFIX,
    );
    const statusResponse = await context.request.get(statusUrl, {
      timeout: this.collectTimeoutMs,
      headers: {
        Accept: "application/json",
        Origin: "https://cursor.com",
        Referer: `${this.collectDashboardUrl.replace(/\/$/, "")}/`,
      },
    });
    if (!statusResponse.ok()) {
      if (statusResponse.status() === 401 || statusResponse.status() === 403) {
        throw new SessionExpiredError();
      }
      throw new CollectionFailedError(
        `usage-status responded ${statusResponse.status()}`,
      );
    }
    const usageStatus: unknown = await statusResponse.json();

    const analyticsUrl = resolveCollectApiUrl(
      this.collectDashboardUrl,
      this.usageAnalyticsUrl,
      DEFAULT_USAGE_ANALYTICS_SUFFIX,
    );
    let analytics: unknown;
    if (analyticsUrl.includes("get-current-period-usage")) {
      const analyticsResponse = await context.request.post(analyticsUrl, {
        timeout: Math.min(this.collectTimeoutMs, 30_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://cursor.com",
          Referer: `${this.collectDashboardUrl.replace(/\/$/, "")}/`,
        },
        data: {},
      });
      if (analyticsResponse.ok()) {
        analytics = await analyticsResponse.json();
      }
    } else {
      const analyticsResponse = await context.request.get(analyticsUrl, {
        timeout: Math.min(this.collectTimeoutMs, 30_000),
        headers: {
          Accept: "application/json",
          Origin: "https://cursor.com",
          Referer: `${this.collectDashboardUrl.replace(/\/$/, "")}/`,
        },
      });
      if (analyticsResponse.ok()) {
        analytics = await analyticsResponse.json();
      }
    }

    return normalizeCursorUsagePayload(usageStatus, analytics);
  }
}

function normalizeUsagePayloadFromNetwork(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") {
    return { raw };
  }
  const body = raw as Record<string, unknown>;
  if (
    body.weeklyIncludedUsage !== undefined ||
    body.weekly_included_usage !== undefined
  ) {
    return normalizeCursorUsagePayload(body);
  }
  return { ...body };
}
