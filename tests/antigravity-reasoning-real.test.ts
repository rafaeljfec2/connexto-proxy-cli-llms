import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "@agent-runtime-gateway/api";
import { initializeGatewayServices, resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const AGY_BINARY = "/home/rafael/.gemini/bin/agy";
const canRunRealTest = fs.existsSync(AGY_BINARY);

describe.runIf(canRunRealTest)("Antigravity Reasoning & Usage Real Validation", () => {
  it("enforces reasoning_effort configuration, rejects unsupported models, and maps reasoning_tokens", async () => {
    const sandboxPath = "/home/rafael/.connexto-proxy/antigravity";
    const userGemini = path.join(os.homedir(), ".gemini");
    const sandboxGemini = path.join(sandboxPath, ".gemini");
    fs.mkdirSync(sandboxGemini, { recursive: true });
    for (const f of ["google_accounts.json", "jetski-standalone-oauth-token", "oauth_creds.json"]) {
      const src = path.join(userGemini, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(sandboxGemini, f));
      }
    }
    const sandboxCliDir = path.join(sandboxGemini, "antigravity-cli");
    fs.mkdirSync(sandboxCliDir, { recursive: true });
    const hostToken = path.join(userGemini, "jetski-standalone-oauth-token");
    if (fs.existsSync(hostToken)) {
      fs.copyFileSync(hostToken, path.join(sandboxCliDir, "antigravity-oauth-token"));
    }
    const userScope = path.join(os.homedir(), ".config", "antigravity", "credential-user-scope");
    const sandboxScopeDir = path.join(sandboxPath, ".config", "antigravity");
    fs.mkdirSync(sandboxScopeDir, { recursive: true });
    if (fs.existsSync(userScope)) {
      fs.copyFileSync(userScope, path.join(sandboxScopeDir, "credential-user-scope"));
    }

    resetGatewayServicesForTest();
    initializeGatewayServices({
      HOST: "127.0.0.1",
      ANTIGRAVITY_STORAGE_PATH: sandboxPath,
      SESSION_STORAGE_DRIVER: "memory",
    });

    const app = buildApp();
    const sessionAffinity = `test-reasoning-${Date.now()}`;

    // ==========================================
    // 1. Rejects reasoning_effort for unsupported model (e.g. claude-sonnet-4-6)
    // ==========================================
    const unsupportedRes = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", `${sessionAffinity}-unsupported`)
      .send({
        model: "antigravity:claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
      });

    expect(unsupportedRes.status).toBe(500);

    // ==========================================
    // 2. Accepts reasoning_effort='high' for gemini-3.8-flash and reports reasoning_tokens
    // ==========================================
    const reasoningRes = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "Solve: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? Answer with just the number.",
          },
        ],
        reasoning_effort: "high",
      });

    expect(reasoningRes.status).toBe(200);
    const body = reasoningRes.body;
    expect(body.choices).toHaveLength(1);
    const choice = body.choices[0];

    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toContain("9");

    // Assert that ACP usage thoughtTokens is mapped into OpenAI reasoning_tokens
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens_details).toBeDefined();
    expect(typeof body.usage.completion_tokens_details.reasoning_tokens).toBe("number");
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThanOrEqual(0);
  }, 120000);
});
