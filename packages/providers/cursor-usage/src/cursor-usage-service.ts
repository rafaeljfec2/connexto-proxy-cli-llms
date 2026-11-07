import crypto from "node:crypto";
import { AccountLockMap } from "./account-lock.js";
import {
  BrowserUnavailableError,
  CollectionFailedError,
  PlaywrightBrowserPool,
  SessionExpiredError,
  type PlaywrightBrowserPool as BrowserPoolType,
} from "./playwright-browser.js";
import { CursorUsageSessionStore } from "./session-store.js";
import type {
  CursorUsageAuthOperation,
  CursorUsageAuthStartResult,
  CursorUsageAuthStatusResult,
  CursorUsageCollectResult,
  CursorUsageServiceOptions,
} from "./types.js";

const DEFAULT_LOGIN = "https://authenticator.cursor.sh/";
const DEFAULT_DASHBOARD = "https://cursor.com/dashboard";
const DEFAULT_USAGE_PATTERN = /usage/i;
/** Post-OAuth landings include /agents (social) and /dashboard (usage UI). */
const DEFAULT_AUTHENTICATED_URL_PATTERN =
  /(^https?:\/\/)?([^/]+\.)?cursor\.com\/(dashboard|settings|agents)(\/?|$|\?)/i;

export class CursorUsageService {
  private readonly sessionStore: CursorUsageSessionStore;
  private readonly browserPool: BrowserPoolType;
  private readonly locks = new AccountLockMap();
  private readonly authOperations = new Map<string, CursorUsageAuthOperation>();
  private readonly liveContexts = new Map<string, import("playwright-core").BrowserContext>();
  private readonly authOperationTtlMs: number;
  private readonly collectTimeoutMs: number;
  private readonly loginUrl: string;
  private readonly dashboardUrl: string;
  private readonly usageUrlPattern: RegExp;
  private readonly authenticatedUrlPattern: RegExp;
  private readonly interactionUrlBase: string;
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
        authHeadless: options.authHeadless,
        authUserDataDirRoot: options.authUserDataDirRoot,
        authViewportWidth: options.authViewportWidth,
        authViewportHeight: options.authViewportHeight,
      });
    this.authOperationTtlMs = options.authOperationTtlMs ?? 30 * 60_000;
    this.collectTimeoutMs = options.collectTimeoutMs ?? 60_000;
    this.loginUrl = options.loginUrl ?? DEFAULT_LOGIN;
    this.dashboardUrl = options.dashboardUrl ?? DEFAULT_DASHBOARD;
    this.usageUrlPattern = options.usageResponseUrlPattern ?? DEFAULT_USAGE_PATTERN;
    this.authenticatedUrlPattern =
      options.authenticatedUrlPattern ?? DEFAULT_AUTHENTICATED_URL_PATTERN;
    this.interactionUrlBase = options.interactionUrlBase ?? "";
  }

  public async collectUsage(accountId: string): Promise<CursorUsageCollectResult> {
    return this.locks.run(accountId, async () => {
      const session = await this.sessionStore.resolve(accountId);
      if (session === undefined || session.status !== "authenticated") {
        return {
          status: "authentication_required",
          provider: "cursor",
          accountId,
        };
      }
      if (session.storageState === undefined) {
        await this.sessionStore.delete(accountId);
        return {
          status: "authentication_required",
          provider: "cursor",
          accountId,
        };
      }

      try {
        const context = await this.browserPool.restoreAuthenticatedSession(
          accountId,
          session.storageState,
        );
        const raw = await this.browserPool.waitForUsageJson({
          context,
          dashboardUrl: this.dashboardUrl,
          urlPattern: this.usageUrlPattern,
          timeoutMs: this.collectTimeoutMs,
        });
        const storageState = await context.storageState();
        await context.close();
        await this.sessionStore.setPersisted({
          ...session,
          status: "authenticated",
          storageState,
        });
        return {
          status: "available",
          provider: "cursor",
          accountId,
          collectedAt: new Date(this.now()).toISOString(),
          usage: normalizeUsage(raw),
          metadata: {
            source: "cursor_dashboard",
            collectionMethod: "browser_network",
          },
        };
      } catch (error) {
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
        if (this.authenticatedUrlPattern.test(url)) {
          const storageState = await this.browserPool.captureStorageState(sessionId);
          operation.status = "authenticated";
          await this.sessionStore.setPersisted({
            accountId: operation.accountId,
            status: "authenticated",
            touchedAt: this.now(),
            storageState,
          });
          await this.browserPool.closeAuthSession(sessionId);
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

}

function normalizeUsage(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object") {
    return { ...(raw as Record<string, unknown>) };
  }
  return { raw: raw as unknown };
}
