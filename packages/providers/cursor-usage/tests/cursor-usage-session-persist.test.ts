import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FilesystemSessionStore,
  InMemorySessionStore,
  createNamespacedStore,
} from "@agent-runtime-gateway/core";
import { CursorUsageService } from "../src/cursor-usage-service.js";
import { PlaywrightBrowserPool } from "../src/playwright-browser.js";
import type { CursorUsageSessionRecord } from "../src/types.js";
import { CURSOR_USAGE_NAMESPACE } from "../src/types.js";

const cursorCookie = {
  name: "session",
  value: "token",
  domain: "cursor.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};

describe("Cursor usage session persistence", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-usage-session-"),
    );
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
  });

  it("rehydrates persisted sessions from disk after a new service instance", async () => {
    const fsStore = new FilesystemSessionStore<CursorUsageSessionRecord>({
      rootDir: sessionDir,
    });
    const store = createNamespacedStore(fsStore, CURSOR_USAGE_NAMESPACE);

    const pool = createStubPool();
    const service1 = new CursorUsageService({ store, browserPool: pool });
    await store.set("acct-disk", {
      accountId: "acct-disk",
      status: "authenticated",
      touchedAt: Date.now(),
      storageState: { cookies: [cursorCookie], origins: [] },
    });

    const service2 = new CursorUsageService({ store, browserPool: pool });
    const status = await service2.getCollectSessionStatus("acct-disk");
    expect(status.status).toBe("authenticated");
  });

  it("does not authenticate when captured storage has no usable cookies", async () => {
    const store = createNamespacedStore(
      new InMemorySessionStore<CursorUsageSessionRecord>(),
      CURSOR_USAGE_NAMESPACE,
    );
    const pool = createStubPool();
    pool.getLiveAuth = vi.fn(
      () =>
        ({
          page: { url: () => "https://cursor.com/dashboard" },
          context: {},
        }) as never,
    );
    pool.captureStorageState = vi.fn(async () => ({
      cookies: [],
      origins: [],
    }));

    const service = new CursorUsageService({ store, browserPool: pool });
    const started = await service.startAuth("acct-empty");
    const status = await service.getAuthStatus(started.sessionId);

    expect(status.status).toBe("authentication_pending");
    expect(pool.captureStorageState).toHaveBeenCalled();
  });
});

function createStubPool(): PlaywrightBrowserPool {
  const stub = Object.create(PlaywrightBrowserPool.prototype) as PlaywrightBrowserPool;
  stub.openAuthSession = vi.fn(async () => ({}) as never);
  stub.getLiveAuth = vi.fn();
  stub.captureStorageState = vi.fn();
  stub.closeAuthSession = vi.fn(async () => undefined);
  stub.shutdown = vi.fn();
  return stub;
}
