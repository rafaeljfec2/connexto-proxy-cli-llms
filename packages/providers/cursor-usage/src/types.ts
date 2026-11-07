import type { BrowserContext } from "playwright-core";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const CURSOR_USAGE_NAMESPACE = "cursor-usage";

export type CursorUsageCollectStatus =
  | "available"
  | "authentication_required"
  | "authentication_pending"
  | "session_expired"
  | "challenge_required"
  | "browser_unavailable"
  | "timeout"
  | "unsupported_response"
  | "collection_failed";

export type CursorUsageAuthStatus =
  | "authentication_pending"
  | "authenticated"
  | "challenge_required"
  | "authentication_failed"
  | "expired";

export interface CursorUsageSessionRecord {
  readonly accountId: string;
  status: CursorUsageAuthStatus | "authenticated";
  touchedAt: number;
  storageState?: StorageState;
}

export interface CursorUsageAuthOperation {
  readonly sessionId: string;
  readonly accountId: string;
  status: CursorUsageAuthStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  interactionUrl?: string;
  lastError?: string;
}

export interface CursorUsageCollectResult {
  readonly status: CursorUsageCollectStatus;
  readonly provider: "cursor";
  readonly accountId: string;
  readonly collectedAt?: string;
  readonly usage?: Record<string, unknown>;
  readonly metadata?: {
    readonly source: string;
    readonly collectionMethod: string;
  };
}

export interface CursorUsageAuthStartResult {
  readonly status: "authentication_pending";
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly interactionUrl: string;
  /** headed = visible Chromium on the proxy host; headless = no desktop window (typical Docker). */
  readonly browserMode: "headed" | "headless";
}

export interface CursorUsageAuthStatusResult {
  readonly sessionId: string;
  readonly accountId: string;
  readonly status: CursorUsageAuthStatus;
  readonly expiresAt: string;
}

export interface CursorUsageCollectSessionStatus {
  readonly status: "authenticated" | "authentication_required";
  readonly accountId: string;
  readonly touchedAt?: string;
}

export interface CursorUsageServiceOptions {
  readonly maxSessions?: number;
  readonly sessionTtlMs?: number;
  readonly authOperationTtlMs?: number;
  readonly collectTimeoutMs?: number;
  readonly loginUrl?: string;
  readonly dashboardUrl?: string;
  readonly usageStatusUrl?: string;
  readonly usageAnalyticsUrl?: string;
  readonly usageResponseUrlPattern?: RegExp;
  readonly authenticatedUrlPattern?: RegExp;
  readonly chromiumExecutablePath?: string;
  readonly authHeadless?: boolean;
  readonly authUserDataDirRoot?: string;
  readonly authViewportWidth?: number;
  readonly authViewportHeight?: number;
  readonly interactionUrlBase?: string;
  readonly store?: import("@agent-runtime-gateway/core").NamespacedSessionStore<CursorUsageSessionRecord>;
  readonly browserPool?: import("./playwright-browser.js").PlaywrightBrowserPool;
  readonly now?: () => number;
}
