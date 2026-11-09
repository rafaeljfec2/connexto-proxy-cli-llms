import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "@agent-runtime-gateway/api";
import { initializeGatewayServices, resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const AGY_BINARY = "/home/rafael/.gemini/bin/agy";
const canRunRealTest = fs.existsSync(AGY_BINARY);

describe.runIf(canRunRealTest)("Antigravity Multi-Tools & Multi-Cycle Real (Option A - agy 1.5.3)", () => {
  it("executes a complete multi-tool, multi-cycle conversation with real agy runtime", async () => {
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
    const sessionAffinity = `test-multi-cycle-${Date.now()}`;
    const markerAlpha = `ALPHA_STAGE_${Math.floor(100000 + Math.random() * 900000)}`;
    const markerBeta = `BETA_STAGE_${Math.floor(100000 + Math.random() * 900000)}`;

    const toolSpecs = [
      {
        type: "function" as const,
        function: {
          name: "fetch_system_status",
          description: "Retrieve system status for a specific node.",
          parameters: {
            type: "object",
            properties: {
              nodeId: { type: "string", description: "Node identifier" },
            },
            required: ["nodeId"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "fetch_security_token",
          description: "Retrieve an authorization token for the node.",
          parameters: {
            type: "object",
            properties: {
              service: { type: "string", description: "Target service name" },
            },
            required: ["service"],
          },
        },
      },
    ];

    // ==========================================
    // Turn 1: Client requests step 1 (fetch_system_status)
    // ==========================================
    const turn1Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "Step 1: Call 'fetch_system_status' with nodeId='node-primary'. Do not call any other tool yet and do not output normal text.",
          },
        ],
        tools: toolSpecs,
      });

    expect(turn1Res.status).toBe(200);
    const turn1Body = turn1Res.body;
    expect(turn1Body.choices).toHaveLength(1);
    const choice1 = turn1Body.choices[0];

    expect(choice1.finish_reason).toBe("tool_calls");
    expect(choice1.message.tool_calls).toBeDefined();
    expect(choice1.message.tool_calls.length).toBeGreaterThan(0);

    const call1 = choice1.message.tool_calls[0];
    expect(call1.function.name).toBe("fetch_system_status");
    expect(call1.id).toMatch(/^call_/);

    // ==========================================
    // Turn 2: Client provides result 1 and requests step 2 (fetch_security_token)
    // ==========================================
    const result1Payload = JSON.stringify({
      nodeId: "node-primary",
      status: "online",
      marker: markerAlpha,
    });

    const turn2Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "Step 1: Call 'fetch_system_status' with nodeId='node-primary'. Do not call any other tool yet and do not output normal text.",
          },
          {
            role: "assistant",
            content: choice1.message.content,
            tool_calls: choice1.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: call1.id,
            name: "fetch_system_status",
            content: result1Payload,
          },
          {
            role: "user",
            content: "Step 2: Now call 'fetch_security_token' with service='auth-gateway'. Do not output normal text.",
          },
        ],
        tools: toolSpecs,
      });

    expect(turn2Res.status).toBe(200);
    const turn2Body = turn2Res.body;
    expect(turn2Body.choices).toHaveLength(1);
    const choice2 = turn2Body.choices[0];

    expect(choice2.finish_reason).toBe("tool_calls");
    expect(choice2.message.tool_calls).toBeDefined();
    expect(choice2.message.tool_calls.length).toBeGreaterThan(0);

    const call2 = choice2.message.tool_calls[0];
    expect(call2.function.name).toBe("fetch_security_token");
    expect(call2.id).toMatch(/^call_/);

    // ==========================================
    // Turn 3: Client provides result 2 and model gives final answer
    // ==========================================
    const result2Payload = JSON.stringify({
      service: "auth-gateway",
      token: "secret-token-xyz",
      marker: markerBeta,
    });

    const turn3Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "Step 1: Call 'fetch_system_status' with nodeId='node-primary'. Do not call any other tool yet and do not output normal text.",
          },
          {
            role: "assistant",
            content: choice1.message.content,
            tool_calls: choice1.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: call1.id,
            name: "fetch_system_status",
            content: result1Payload,
          },
          {
            role: "user",
            content: "Step 2: Now call 'fetch_security_token' with service='auth-gateway'. Do not output normal text.",
          },
          {
            role: "assistant",
            content: choice2.message.content,
            tool_calls: choice2.message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: call2.id,
            name: "fetch_security_token",
            content: result2Payload,
          },
          {
            role: "user",
            content: "Step 3: Summarize the results from both steps, including both markers.",
          },
        ],
        tools: toolSpecs,
      });

    expect(turn3Res.status).toBe(200);
    const turn3Body = turn3Res.body;
    expect(turn3Body.choices).toHaveLength(1);
    const choice3 = turn3Body.choices[0];

    expect(choice3.finish_reason).toBe("stop");
    expect(typeof choice3.message.content).toBe("string");

    // Both markers from the separate execution cycles must be present in the final output
    expect(choice3.message.content).toContain(markerAlpha);
    expect(choice3.message.content).toContain(markerBeta);
  }, 120000);
});

