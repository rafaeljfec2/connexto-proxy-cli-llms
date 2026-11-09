import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "@agent-runtime-gateway/api";
import { initializeGatewayServices, resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const AGY_BINARY = "/home/rafael/.gemini/bin/agy";
const canRunRealTest = fs.existsSync(AGY_BINARY);

describe.runIf(canRunRealTest)("Antigravity tool_choice & parallel_tool_calls Real Validation", () => {
  it("enforces tool_choice='required' and rejects missing tools", async () => {
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
    const sessionAffinity = `test-tool-choice-${Date.now()}`;

    const toolSpec = {
      type: "function" as const,
      function: {
        name: "get_secret_vault",
        description: "Fetch secret vault configuration.",
        parameters: {
          type: "object",
          properties: {
            vaultId: { type: "string" },
          },
          required: ["vaultId"],
        },
      },
    };

    // 1. Rejection of non-existent tool_choice function name
    const invalidChoiceRes = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", `${sessionAffinity}-invalid`)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [{ role: "user", content: "Hello" }],
        tools: [toolSpec],
        tool_choice: { type: "function", function: { name: "non_existent_function" } },
      });

    expect(invalidChoiceRes.status).toBe(500);

    // 2. tool_choice: "required" forces the model to call the tool
    const requiredRes = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "What is the secret vault config for vault-123? Call the tool to find out.",
          },
        ],
        tools: [toolSpec],
        tool_choice: "required",
        parallel_tool_calls: false,
      });

    expect(requiredRes.status).toBe(200);
    const body = requiredRes.body;
    expect(body.choices).toHaveLength(1);
    const choice = body.choices[0];

    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toBeDefined();
    expect(choice.message.tool_calls[0].function.name).toBe("get_secret_vault");
  }, 120000);
});

