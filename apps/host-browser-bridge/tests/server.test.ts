import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createBridgeServer } from "../src/server.js";
import { BrowserSessionManager } from "../src/session-manager.js";
import { AuthStateMonitor } from "../src/auth-monitor.js";
import { ChromeLauncher } from "../src/chrome-launcher.js";
import type { ChromeProcess } from "../src/types.js";

function setupTestApp() {
  const launchedProcesses = new Map<string, ChromeProcess>();

  const launcher = {
    launch: vi.fn((sessionId: string): Promise<ChromeProcess> => {
      let alive = true;
      const proc: ChromeProcess = {
        processId: 12345,
        port: 19876,
        userDataDir: `/tmp/test-profile-${sessionId}`,
        wsEndpoint: `ws://127.0.0.1:19876/devtools/browser/${sessionId}`,
        close: vi.fn(() => {
          alive = false;
          return Promise.resolve();
        }),
        isAlive: () => alive,
      };
      launchedProcesses.set(sessionId, proc);
      return Promise.resolve(proc);
    }),
    resolvePrincipalUserDataDir: vi.fn((principalId: string) => `/tmp/test-profile-${principalId}`),
    resolveSessionUserDataDir: vi.fn((sessionId: string) => `/tmp/test-profile-${sessionId}`),
  } as unknown as ChromeLauncher;

  const sessionManager = new BrowserSessionManager({
    launcher,
    cleanupProfileOnClose: false,
  });

  const authMonitor = {
    attachSession: vi.fn(() => Promise.resolve()),
    checkSessionAuth: vi.fn(() =>
      Promise.resolve({ status: "waiting_for_login" as const }),
    ),
    detachSession: vi.fn(() => Promise.resolve()),
  } as unknown as AuthStateMonitor;

  const TEST_TOKEN = "secret-test-token-123";
  const { server } = createBridgeServer({
    sessionManager,
    authMonitor,
    bridgeToken: TEST_TOKEN,
  });

  return { app: server, sessionManager, TEST_TOKEN };
}

describe("Bridge HTTP Server", () => {
  it("allows unauthenticated GET /health", async () => {
    const { app } = setupTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.activeSessions).toBe(0);
  });

  it("rejects /internal requests without token", async () => {
    const { app } = setupTestApp();
    const res = await request(app)
      .post("/internal/browser/sessions")
      .send({ principalId: "user-1", target: "cursor" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects /internal requests with invalid token", async () => {
    const { app } = setupTestApp();
    const res = await request(app)
      .post("/internal/browser/sessions")
      .set("Authorization", "Bearer wrong-token")
      .send({ principalId: "user-1", target: "cursor" });

    expect(res.status).toBe(401);
  });

  it("creates a session with valid token and returns safe session DTO", async () => {
    const { app, TEST_TOKEN } = setupTestApp();
    const res = await request(app)
      .post("/internal/browser/sessions")
      .set("x-bridge-token", TEST_TOKEN)
      .send({
        principalId: "user-alice",
        target: "cursor",
        targetUrl: "https://cursor.com/login",
      });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.principalId).toBe("user-alice");
    expect(res.body.status).toBe("waiting_for_login");
    // Must NOT leak internal CDP ports or ws urls to callers
    expect(res.body.cdpPort).toBeUndefined();
    expect(res.body.wsEndpoint).toBeUndefined();
  });

  it("blocks SSRF targetUrl attempts with 400 ssrf_violation", async () => {
    const { app, TEST_TOKEN } = setupTestApp();
    const res = await request(app)
      .post("/internal/browser/sessions")
      .set("Authorization", `Bearer ${TEST_TOKEN}`)
      .send({
        principalId: "user-alice",
        target: "cursor",
        targetUrl: "http://169.254.169.254/latest/meta-data/",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ssrf_violation");
  });

  it("enforces ownership isolation when querying session", async () => {
    const { app, TEST_TOKEN } = setupTestApp();

    // Create session for Alice
    const createRes = await request(app)
      .post("/internal/browser/sessions")
      .set("x-bridge-token", TEST_TOKEN)
      .send({ principalId: "user-alice", target: "cursor" });

    const sessionId = createRes.body.sessionId;

    // Bob attempts to query Alice's session -> 403 Forbidden
    const bobRes = await request(app)
      .get(`/internal/browser/sessions/${sessionId}`)
      .set("x-bridge-token", TEST_TOKEN)
      .set("x-principal-id", "user-bob");

    expect(bobRes.status).toBe(403);
    expect(bobRes.body.error.code).toBe("forbidden");

    // Alice queries her own session -> 200 OK
    const aliceRes = await request(app)
      .get(`/internal/browser/sessions/${sessionId}`)
      .set("x-bridge-token", TEST_TOKEN)
      .query({ principalId: "user-alice" });

    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.sessionId).toBe(sessionId);
    expect(aliceRes.body.status).toBe("waiting_for_login");
  });

  it("enforces ownership isolation when deleting session", async () => {
    const { app, TEST_TOKEN } = setupTestApp();

    const createRes = await request(app)
      .post("/internal/browser/sessions")
      .set("x-bridge-token", TEST_TOKEN)
      .send({ principalId: "user-alice", target: "cursor" });

    const sessionId = createRes.body.sessionId;

    // Bob cannot delete Alice's session
    const bobDel = await request(app)
      .delete(`/internal/browser/sessions/${sessionId}`)
      .set("x-bridge-token", TEST_TOKEN)
      .set("x-principal-id", "user-bob");

    expect(bobDel.status).toBe(403);

    // Alice deletes her session -> 204 No Content
    const aliceDel = await request(app)
      .delete(`/internal/browser/sessions/${sessionId}`)
      .set("x-bridge-token", TEST_TOKEN)
      .set("x-principal-id", "user-alice");

    expect(aliceDel.status).toBe(204);
  });
});
