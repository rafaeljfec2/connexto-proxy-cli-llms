import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import {
  AntigravityAuthManager,
  AntigravityProvider,
  AntigravityUsageService,
} from "@agent-runtime-gateway/provider-antigravity";
import {
  initializeGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";

describe("Antigravity logout and credential clearing", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ag-logout-test-"));
    const geminiDir = path.join(tmpHome, ".gemini");
    const agCliDir = path.join(geminiDir, "antigravity-cli");
    const configDir = path.join(tmpHome, ".config", "antigravity");

    await fs.mkdir(agCliDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    // Populate fake credentials
    await fs.writeFile(
      path.join(geminiDir, "google_accounts.json"),
      JSON.stringify({ active: "connected-user@example.com" }),
    );
    await fs.writeFile(
      path.join(geminiDir, "oauth_creds.json"),
      JSON.stringify({
        access_token: "ya29.fake-token",
        expiry_date: Date.now() + 3600_000,
      }),
    );
    await fs.writeFile(
      path.join(geminiDir, "jetski-standalone-oauth-token"),
      JSON.stringify({
        id_token_email: "connected-user@example.com",
        token: "ya29.fake-token",
      }),
    );
    await fs.writeFile(
      path.join(agCliDir, "antigravity-oauth-token"),
      JSON.stringify({ token: "fake-cli-token" }),
    );
    await fs.writeFile(path.join(configDir, "credential-user-scope"), "scope-12345");

    resetGatewayServicesForTest();
    const authManager = new AntigravityAuthManager({ homeDir: tmpHome });
    const usageService = new AntigravityUsageService({
      homeDir: tmpHome,
    });

    initializeGatewayServices(
      {
        HOST: "127.0.0.1",
        SESSION_STORAGE_DRIVER: "memory",
      },
      {
        antigravityAuthManager: authManager,
        antigravityUsageService: usageService,
      },
    );
  });

  afterEach(async () => {
    resetGatewayServicesForTest();
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
  });

  it("POST /v1/providers/antigravity/auth/logout purges all local credentials", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    // 1. Verify initially authenticated
    const statusBefore = await request(app).get(
      "/v1/providers/antigravity/auth/status",
    );
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.authenticated).toBe(true);
    expect(statusBefore.body.account).toBe("connected-user@example.com");

    // 2. Call logout
    const logoutRes = await request(app).post("/v1/providers/antigravity/auth/logout");
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);
    expect(logoutRes.body.removed_files.length).toBe(5);

    // 3. Verify status transitions to unauthenticated
    const statusAfter = await request(app).get("/v1/providers/antigravity/auth/status");
    expect(statusAfter.status).toBe(200);
    expect(statusAfter.body.authenticated).toBe(false);
    expect(statusAfter.body.account).toBeUndefined();

    // 4. Verify usage endpoint returns 503 unauthenticated
    const usageRes = await request(app).get("/v1/providers/antigravity/usage");
    expect(usageRes.status).toBe(503);
    expect(usageRes.body.status).toBe("unauthenticated");
  });

  it("POST /v1/runtime/sessions/clear with namespace antigravity purges credentials", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    // Mock closePersistedAcpSessions
    vi.spyOn(
      AntigravityProvider.prototype,
      "closePersistedAcpSessions",
    ).mockResolvedValue({
      mapped_acp_ids_count: 0,
      listed_acp_sessions_count: 0,
      acp_sessions_closed: 0,
      acp_close_failures: 0,
      warnings: [],
    });

    const res = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "antigravity" });

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(res.body.credentials_purged).toBe(true);

    // Verify status is now unauthenticated
    const statusAfter = await request(app).get("/v1/providers/antigravity/auth/status");
    expect(statusAfter.status).toBe(200);
    expect(statusAfter.body.authenticated).toBe(false);
    expect(statusAfter.body.account).toBeUndefined();
  });
});
