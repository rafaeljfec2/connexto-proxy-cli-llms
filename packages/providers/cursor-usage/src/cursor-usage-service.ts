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

const DEFAULT_LOGIN = "https://authenticator.cursor.sh/";
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
  private readonly liveContexts = new Map<string, import("playwright-core").BrowserContext>();
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
  }

  public async collectUsage(accountId: string): Promise<CursorUsageCollectResult> {
    return this.locks.run(accountId, async () => {
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
      } else if (
        !isCollectableSessionRecord(session, profilePresent)
      ) {
        await this.sessionStore.delete(accountId);
        return {
          status: "authentication_required",
          provider: "cursor",
          accountId,
        };
      }

      try {
        const restoredState =
          session?.storageState ?? { cookies: [], origins: [] };
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

  public async startAuth(accountId: string): Promise<CursorUsageAuthStartResult> {
    return this.locks.run(accountId, async () => {
      this.purgeExpiredAuthOperations();
      const sessionId = crypto.randomUUID();
      const expiresAt = this.now() + this.authOperationTtlMs;
      const interactionUrl = `${this.interactionUrlBase}/v1/providers/cursor/auth/${sessionId}/interaction`;

      try {
        await this.browserPool.openAuthSession(sessionId, accountId, this.loginUrl);
      } catch (error) {
        if (error instanceof BrowserUnavailableError) {
          throw error;
        }
        throw error;
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
        browserMode: this.authHeadless ? "headless" : "headed",
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
                    reason: written ? "resolve_empty_after_write" : "set_persisted_rejected",
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

  public async getCollectSessionStatus(
    accountId: string,
  ): Promise<{
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
  const body =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : { raw };
  if (
    body.weeklyIncludedUsage !== undefined ||
    body.weekly_included_usage !== undefined
  ) {
    return normalizeCursorUsagePayload(body);
  }
  return { ...(body as Record<string, unknown>) };
}
