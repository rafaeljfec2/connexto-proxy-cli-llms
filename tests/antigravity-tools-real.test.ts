import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "@agent-runtime-gateway/api";
import { initializeGatewayServices, resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const AGY_BINARY = "/home/rafael/.gemini/bin/agy";
const canRunRealTest = fs.existsSync(AGY_BINARY);

describe.runIf(canRunRealTest)("Antigravity Function Tools Real Cycle (Option A - agy 1.5.3)", () => {
  it("executes a complete end-to-end two-turn delegated tool cycle with real agy runtime", async () => {
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
    const sessionAffinity = `test-tool-cycle-${Date.now()}`;
    const randomMarker = `EXTERNAL_RESULT_${Math.floor(100000 + Math.random() * 900000)}`;

    const toolSpec = {
      type: "function" as const,
      function: {
        name: "get_external_test_context",
        description: "Retrieve external verification context from the client environment.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The context query key to lookup",
            },
          },
          required: ["query"],
        },
      },
    };

    // ==========================================
    // Turn 1: Client sends tool definition & prompt
    // ==========================================
    const turn1Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "You must call the tool 'get_external_test_context' with query='verification_probe'. Do not answer with normal text without calling this tool.",
          },
        ],
        tools: [toolSpec],
      });

    expect(turn1Res.status).toBe(200);
    const turn1Body = turn1Res.body;
    expect(turn1Body.choices).toHaveLength(1);
    const choice1 = turn1Body.choices[0];

    // Assert that Proxy captured the ACP tool call and returned finish_reason = "tool_calls"
    expect(choice1.finish_reason).toBe("tool_calls");
    expect(choice1.message.tool_calls).toBeDefined();
    expect(choice1.message.tool_calls.length).toBeGreaterThan(0);

    const capturedCall = choice1.message.tool_calls[0];
    expect(capturedCall.type).toBe("function");
    expect(capturedCall.function.name).toBe("get_external_test_context");
    expect(capturedCall.id).toMatch(/^call_/);

    const callArgs = JSON.parse(capturedCall.function.arguments);
    expect(callArgs.query).toBe("verification_probe");

    // ==========================================
    // Step 4: Consumer executes tool locally
    // (Simulated by generating the unique external marker)
    // ==========================================
    const externalToolOutput = JSON.stringify({
      status: "success",
      marker: randomMarker,
      payload: "consumer-controlled-execution-evidence",
    });

    // ==========================================
    // Turn 2: Consumer sends tool result to Proxy
    // ==========================================
    const turn2Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "You must call the tool 'get_external_test_context' with query='verification_probe'. Do not answer with normal text without calling this tool.",
          },
          {
            role: "assistant",
            content: choice1.message.content,
            tool_calls: choice1.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: capturedCall.id,
            name: "get_external_test_context",
            content: externalToolOutput,
          },
        ],
        tools: [toolSpec],
      });

    expect(turn2Res.status).toBe(200);
    const turn2Body = turn2Res.body;
    expect(turn2Body.choices).toHaveLength(1);
    const choice2 = turn2Body.choices[0];

    expect(choice2.finish_reason).toBe("stop");
    expect(typeof choice2.message.content).toBe("string");

    // ==========================================
    // Proof of correctness:
    // The final answer MUST incorporate the exact external marker!
    // ==========================================
    expect(choice2.message.content).toContain(randomMarker);
  }, 120000);
});
