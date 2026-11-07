import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { CursorUsageService } from "../src/cursor-usage-service.js";
import { PlaywrightBrowserPool } from "../src/playwright-browser.js";
import { InMemorySessionStore, createNamespacedStore } from "@agent-runtime-gateway/core";
import type { CursorUsageSessionRecord } from "../src/types.js";
import { CURSOR_USAGE_NAMESPACE } from "../src/types.js";

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
      storageState: { cookies: [], origins: [] },
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
  });

  it("marks auth complete when social login lands on cursor.com/agents", async () => {
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
    pool.captureStorageState = vi.fn(async () => ({
      cookies: [{ name: "session", value: "x", domain: "cursor.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }],
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
  } as unknown as BrowserContext;

  const stub = Object.create(PlaywrightBrowserPool.prototype) as PlaywrightBrowserPool;
  stub.restoreAuthenticatedSession = vi.fn(async () => mockContext);
  stub.waitForUsageJson = vi.fn(async () => options.usageJson ?? {});
  stub.openAuthSession = vi.fn();
  stub.getLiveAuth = vi.fn();
  stub.closeAuthSession = vi.fn();
  stub.captureStorageState = vi.fn();
  stub.shutdown = vi.fn();
  return stub;
}
