import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { CursorUsageService } from "../src/cursor-usage-service.js";
import { PlaywrightBrowserPool } from "../src/playwright-browser.js";
import { InMemorySessionStore, createNamespacedStore } from "@agent-runtime-gateway/core";
import type { CursorUsageSessionRecord } from "../src/types.js";
import { CURSOR_USAGE_NAMESPACE } from "../src/types.js";

const cursorDomainCookie = {
  name: "session",
  value: "x",
  domain: "cursor.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};

describe("CursorUsageService", () => {
  it("returns authentication_required when no session", async () => {
    const service = new CursorUsageService({
      browserPool: createStubPool(),
    });
    const result = await service.collectUsage("acct-1");
    expect(result.status).toBe("authentication_required");
  });

  it("collects usage when session is authenticated", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    await store.set("acct-2", {
      accountId: "acct-2",
      status: "authenticated",
      touchedAt: Date.now(),
      storageState: { cookies: [cursorDomainCookie], origins: [] },
    });

    const pool = createStubPool({
      usageJson: { used: 12, limit: 100 },
    });

    const service = new CursorUsageService({
      store,
      browserPool: pool,
    });

    const result = await service.collectUsage("acct-2");
    expect(result.status).toBe("available");
    expect(result.usage).toEqual({ used: 12, limit: 100 });
    expect(pool.waitForUsageJson).toHaveBeenCalled();
  });

  it("prefers dashboard API when usage-status responds ok", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    await store.set("acct-api", {
      accountId: "acct-api",
      status: "authenticated",
      touchedAt: Date.now(),
      storageState: { cookies: [cursorDomainCookie], origins: [] },
    });

    const pool = createStubPool();
    const mockContext = {
      storageState: vi.fn(async () => ({
        cookies: [cursorDomainCookie],
        origins: [],
      })),
      close: vi.fn(async () => undefined),
      request: {
        get: vi.fn(async (url: string) => {
          if (String(url).includes("usage-status")) {
            return {
              ok: () => true,
              status: () => 200,
              json: async () => ({
                weeklyIncludedUsage: { usedCents: 4168, budgetCents: 4615 },
              }),
            };
          }
          return { ok: () => false, status: () => 404 };
        }),
      },
    };
    pool.restoreAuthenticatedSession = vi.fn(async () => mockContext as never);

    const service = new CursorUsageService({ store, browserPool: pool });
    const result = await service.collectUsage("acct-api");

    expect(result.status).toBe("available");
    expect(result.usage?.total_usage).toBe(41.68);
    expect(result.usage?.total_credits).toBe(46.15);
    expect(pool.waitForUsageJson).not.toHaveBeenCalled();
  });

  it("returns authentication_required when session cookies are not usable", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    await store.set("acct-bad", {
      accountId: "acct-bad",
      status: "authenticated",
      touchedAt: Date.now(),
      storageState: { cookies: [], origins: [] },
    });
    const service = new CursorUsageService({
      store,
      browserPool: createStubPool(),
    });
    const result = await service.collectUsage("acct-bad");
    expect(result.status).toBe("authentication_required");
  });

  it("stays pending when login lands on grok.com/dashboard without cookies", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    const pool = createStubPool();
    pool.openAuthSession = vi.fn(async () => ({}) as never);
    pool.getLiveAuth = vi.fn(
      () =>
        ({
          page: { url: () => "https://grok.com/dashboard" },
          context: {},
        }) as never,
    );
    pool.captureStorageState = vi.fn(async () => ({
      cookies: [],
      origins: [],
    }));
    pool.closeAuthSession = vi.fn(async () => undefined);

    const service = new CursorUsageService({ store, browserPool: pool });
    const started = await service.startAuth("acct-grok");
    const status = await service.getAuthStatus(started.sessionId);

    expect(status.status).toBe("authentication_pending");
  });

  it("stays pending when login stops on cursor.com/agents", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    const pool = createStubPool();
    pool.openAuthSession = vi.fn(async () => ({}) as never);
    pool.getLiveAuth = vi.fn(
      () =>
        ({
          page: { url: () => "https://cursor.com/agents" },
          context: {},
        }) as never,
    );

    const service = new CursorUsageService({ store, browserPool: pool });
    const started = await service.startAuth("acct-agents-only");
    const status = await service.getAuthStatus(started.sessionId);

    expect(status.status).toBe("authentication_pending");
    expect(pool.captureStorageState).not.toHaveBeenCalled();
  });

  it("marks auth complete when login reaches grok.com/dashboard", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    const pool = createStubPool();
    pool.openAuthSession = vi.fn(async () => ({}) as never);
    pool.getLiveAuth = vi.fn(
      () =>
        ({
          page: { url: () => "https://grok.com/dashboard" },
          context: {},
        }) as never,
    );
    pool.pageHasUpstreamChallenge = vi.fn(async () => false);
    pool.captureStorageState = vi.fn(async () => ({
      cookies: [cursorDomainCookie],
      origins: [],
    }));
    pool.closeAuthSession = vi.fn(async () => undefined);

    const service = new CursorUsageService({ store, browserPool: pool });
    const started = await service.startAuth("acct-social");
    const status = await service.getAuthStatus(started.sessionId);

    expect(status.status).toBe("authenticated");
    expect(pool.captureStorageState).toHaveBeenCalledWith(started.sessionId);
  });
});

function createStubPool(options: { usageJson?: unknown } = {}): PlaywrightBrowserPool {
  const mockContext = {
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => undefined),
    request: {
      get: vi.fn(async () => ({
        ok: () => false,
        status: () => 404,
      })),
    },
  } as unknown as BrowserContext;

  const stub = Object.create(PlaywrightBrowserPool.prototype) as PlaywrightBrowserPool;
  stub.restoreAuthenticatedSession = vi.fn(async () => mockContext);
  stub.primeCollectDashboard = vi.fn(async () => undefined);
  stub.waitForUsageJson = vi.fn(async () => options.usageJson ?? {});
  stub.openAuthSession = vi.fn();
  stub.getLiveAuth = vi.fn();
  stub.closeAuthSession = vi.fn();
  stub.captureStorageState = vi.fn();
  stub.pageHasUpstreamChallenge = vi.fn(async () => false);
  stub.hasActiveAuthForAccount = vi.fn(() => false);
  stub.hasAuthProfile = vi.fn(() => false);
  stub.shutdown = vi.fn();
  return stub;
}
