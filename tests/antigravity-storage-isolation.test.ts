import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import {
  AntigravityTokenResolver,
} from "@agent-runtime-gateway/provider-antigravity";
import {
  initializeGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";

describe("Antigravity Storage Isolation (IDE vs Proxy)", () => {
  let fakeHostHome: string;
  let fakeProxyStorage: string;

  beforeEach(async () => {
    fakeHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "ag-host-ide-"));
    fakeProxyStorage = await fs.mkdtemp(path.join(os.tmpdir(), "ag-proxy-storage-"));

    // 1. Setup simulated host Antigravity IDE credentials in fakeHostHome/.gemini
    const hostGeminiDir = path.join(fakeHostHome, ".gemini");
    await fs.mkdir(hostGeminiDir, { recursive: true });
    await fs.writeFile(
      path.join(hostGeminiDir, "google_accounts.json"),
      JSON.stringify({ active: "ide-user@example.com" }),
    );
    await fs.writeFile(
      path.join(hostGeminiDir, "jetski-standalone-oauth-token"),
      JSON.stringify({
        id_token_email: "ide-user@example.com",
        access_token: "ya29.ide-active-token",
      }),
    );

    // 2. Setup simulated Proxy credentials in fakeProxyStorage/.gemini
    const proxyGeminiDir = path.join(fakeProxyStorage, ".gemini");
    await fs.mkdir(proxyGeminiDir, { recursive: true });
    await fs.writeFile(
      path.join(proxyGeminiDir, "google_accounts.json"),
      JSON.stringify({ active: "proxy-user@example.com" }),
    );
    await fs.writeFile(
      path.join(proxyGeminiDir, "jetski-standalone-oauth-token"),
      JSON.stringify({
        id_token_email: "proxy-user@example.com",
        access_token: "ya29.proxy-active-token",
      }),
    );

    resetGatewayServicesForTest();
  });

  afterEach(async () => {
    resetGatewayServicesForTest();
    await fs.rm(fakeHostHome, { recursive: true, force: true });
    await fs.rm(fakeProxyStorage, { recursive: true, force: true });
  });

  it("resolves credentials from ANTIGRAVITY_STORAGE_PATH, ignoring host IDE files", async () => {
    initializeGatewayServices({
      HOST: "127.0.0.1",
      ANTIGRAVITY_STORAGE_PATH: fakeProxyStorage,
    });

    const app = buildApp();
    const res = await request(app).get("/v1/providers/antigravity/auth/status");

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.account).toBe("proxy-user@example.com");
  });

  it("purging proxy credentials leaves host IDE credentials untouched", async () => {
    initializeGatewayServices({
      HOST: "127.0.0.1",
      ANTIGRAVITY_STORAGE_PATH: fakeProxyStorage,
    });

    const app = buildApp();

    // Clear runtime session for antigravity
    const clearRes = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "antigravity" });

    expect(clearRes.status).toBe(200);

    // Verify proxy credentials were removed
    const proxyTokenPath = path.join(
      fakeProxyStorage,
      ".gemini",
      "jetski-standalone-oauth-token",
    );
    await expect(fs.access(proxyTokenPath)).rejects.toThrow();

    // Verify proxy status is now unauthenticated
    const statusRes = await request(app).get("/v1/providers/antigravity/auth/status");
    expect(statusRes.body.authenticated).toBe(false);

    // CRITICAL: Verify host IDE credentials STILL EXIST and are INTACT!
    const hostAccountsPath = path.join(fakeHostHome, ".gemini", "google_accounts.json");
    const hostTokenPath = path.join(
      fakeHostHome,
      ".gemini",
      "jetski-standalone-oauth-token",
    );

    const hostAccountsContent = await fs.readFile(hostAccountsPath, "utf-8");
    const hostTokenContent = await fs.readFile(hostTokenPath, "utf-8");

    expect(JSON.parse(hostAccountsContent)).toEqual({
      active: "ide-user@example.com",
    });
    expect(JSON.parse(hostTokenContent)).toEqual({
      id_token_email: "ide-user@example.com",
      access_token: "ya29.ide-active-token",
    });

    // Verify host token resolver still resolves the IDE credentials
    const hostResolver = new AntigravityTokenResolver({ homeDir: fakeHostHome });
    const hostCredentials = await hostResolver.resolveCredentials();
    expect(hostCredentials?.email).toBe("ide-user@example.com");
    expect(hostCredentials?.accessToken).toBe("ya29.ide-active-token");
  });
});
