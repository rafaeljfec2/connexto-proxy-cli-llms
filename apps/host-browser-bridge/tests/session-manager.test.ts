import { describe, it, expect, vi } from "vitest";
import { BrowserSessionManager } from "../src/session-manager.js";
import { ChromeLauncher } from "../src/chrome-launcher.js";
import {
  SessionLimitError,
  SessionNotFoundError,
  SessionOwnershipError,
  type ChromeProcess,
} from "../src/types.js";

function createMockLauncher(): {
  launcher: ChromeLauncher;
  launchMock: ReturnType<typeof vi.fn>;
  launchedProcesses: Map<string, { proc: ChromeProcess; closeMock: ReturnType<typeof vi.fn> }>;
} {
  const launchedProcesses = new Map<
    string,
    { proc: ChromeProcess; closeMock: ReturnType<typeof vi.fn> }
  >();

  const launchMock = vi.fn((sessionId: string): Promise<ChromeProcess> => {
    let alive = true;
    const closeMock = vi.fn(() => {
      alive = false;
      return Promise.resolve();
    });
    const proc: ChromeProcess = {
      processId: 1000 + launchedProcesses.size,
      port: 19000 + launchedProcesses.size,
      userDataDir: `/tmp/connexto-test-profiles/${sessionId}`,
      wsEndpoint: `ws://127.0.0.1:19000/devtools/browser/${sessionId}`,
      close: closeMock,
      isAlive: () => alive,
    };
    launchedProcesses.set(sessionId, { proc, closeMock });
    return Promise.resolve(proc);
  });

  const launcher = {
    launch: launchMock,
    resolvePrincipalUserDataDir: vi.fn((principalId: string) => `/tmp/connexto-test-profiles/${principalId}`),
    resolveSessionUserDataDir: vi.fn((sessionId: string) => `/tmp/connexto-test-profiles/${sessionId}`),
  } as unknown as ChromeLauncher;

  return { launcher, launchMock, launchedProcesses };
}

describe("BrowserSessionManager", () => {
  it("creates a session and sets waiting_for_login status", async () => {
    const { launcher } = createMockLauncher();
    const manager = new BrowserSessionManager({ launcher });

    const session = await manager.createSession({
      principalId: "user-1",
      target: "cursor",
    });

    expect(session.id).toBeDefined();
    expect(session.principalId).toBe("user-1");
    expect(session.target).toBe("cursor");
    expect(session.status).toBe("waiting_for_login");
    expect(session.cdpPort).toBeGreaterThan(0);
    expect(manager.activeSessionsCount).toBe(1);
  });

  it("enforces session ownership on getSession", async () => {
    const { launcher } = createMockLauncher();
    const manager = new BrowserSessionManager({ launcher });

    const session = await manager.createSession({
      principalId: "user-alice",
      target: "cursor",
    });

    // Alice can access
    const retrieved = manager.getSession(session.id, "user-alice");
    expect(retrieved.id).toBe(session.id);

    // Bob cannot access Alice's session
    expect(() => {
      manager.getSession(session.id, "user-bob");
    }).toThrow(SessionOwnershipError);
  });

  it("throws SessionNotFoundError for nonexistent session", () => {
    const { launcher } = createMockLauncher();
    const manager = new BrowserSessionManager({ launcher });

    expect(() => {
      manager.getSession("non-existent-id", "user-1");
    }).toThrow(SessionNotFoundError);
  });

  it("is idempotent when recreating existing session with same id and principal", async () => {
    const { launcher, launchMock } = createMockLauncher();
    const manager = new BrowserSessionManager({ launcher });

    const session1 = await manager.createSession({
      id: "fixed-session-id",
      principalId: "user-alice",
      target: "cursor",
    });

    const session2 = await manager.createSession({
      id: "fixed-session-id",
      principalId: "user-alice",
      target: "cursor",
    });

    expect(session1.id).toBe(session2.id);
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects recreation of existing session id with different principal", async () => {
    const { launcher } = createMockLauncher();
    const manager = new BrowserSessionManager({ launcher });

    await manager.createSession({
      id: "shared-id",
      principalId: "user-alice",
      target: "cursor",
    });

    await expect(
      manager.createSession({
        id: "shared-id",
        principalId: "user-bob",
        target: "cursor",
      }),
    ).rejects.toThrow(SessionOwnershipError);
  });

  it("enforces maximum concurrent sessions limit", async () => {
    const { launcher } = createMockLauncher();
    const manager = new BrowserSessionManager({
      launcher,
      maxConcurrentSessions: 2,
    });

    await manager.createSession({ principalId: "user-1", target: "cursor" });
    await manager.createSession({ principalId: "user-2", target: "cursor" });

    await expect(
      manager.createSession({ principalId: "user-3", target: "cursor" }),
    ).rejects.toThrow(SessionLimitError);
  });

  it("closing session A isolates and does not terminate session B", async () => {
    const { launcher, launchedProcesses } = createMockLauncher();
    const manager = new BrowserSessionManager({
      launcher,
      cleanupProfileOnClose: false,
    });

    const sessionA = await manager.createSession({
      principalId: "user-1",
      target: "service-a",
    });
    const sessionB = await manager.createSession({
      principalId: "user-2",
      target: "service-b",
    });

    const entryA = launchedProcesses.get(sessionA.id);
    const entryB = launchedProcesses.get(sessionB.id);

    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA?.proc.isAlive()).toBe(true);
    expect(entryB?.proc.isAlive()).toBe(true);

    // Close session A
    await manager.closeSession(sessionA.id, "user-1");

    expect(entryA?.closeMock).toHaveBeenCalledTimes(1);
    expect(entryA?.proc.isAlive()).toBe(false);

    // Session B must remain completely intact and alive
    expect(entryB?.closeMock).not.toHaveBeenCalled();
    expect(entryB?.proc.isAlive()).toBe(true);
    expect(manager.getSession(sessionB.id, "user-2").status).toBe("waiting_for_login");
    expect(manager.activeSessionsCount).toBe(1);

    // Cleanup session B
    await manager.closeSession(sessionB.id, "user-2");
    expect(entryB?.closeMock).toHaveBeenCalledTimes(1);
    expect(manager.activeSessionsCount).toBe(0);
  });
});
