import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildApp } from "@agent-runtime-gateway/api";
import { initializeGatewayServices, resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const AGY_BINARY = "/home/rafael/.gemini/bin/agy";
const canRunRealTest = fs.existsSync(AGY_BINARY);

describe.runIf(canRunRealTest)("Antigravity Streaming Tools & Responses API Real Validation", () => {
  it("streams tool calls and completion deltas over SSE and supports Responses API", async () => {
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
    const sessionAffinity = `test-stream-tools-${Date.now()}`;
    const marker = `STREAM_MARKER_${Math.floor(100000 + Math.random() * 900000)}`;

    const toolSpec = {
      type: "function" as const,
      function: {
        name: "get_stream_telemetry",
        description: "Fetch real-time telemetry metrics.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string" },
          },
          required: ["channel"],
        },
      },
    };

    // ==========================================
    // 1. Streaming chat completion with tool call
    // ==========================================
    const streamTurn1Res = await request(app)
      .post("/v1/chat/completions")
      .set("x-session-affinity", sessionAffinity)
      .send({
        model: "antigravity:gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: "Call tool 'get_stream_telemetry' with channel='alpha-live'. No plain text.",
          },
        ],
        tools: [toolSpec],
        stream: true,
      });

    expect(streamTurn1Res.status).toBe(200);
    expect(streamTurn1Res.headers["content-type"]).toContain("text/event-stream");

    const sseLines = streamTurn1Res.text.split("\n");
    let foundToolChunk = false;
    let foundFinishChunk = false;
    let capturedToolCallId: string | undefined;

    for (const line of sseLines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta;
          if (delta?.tool_calls && delta.tool_calls.length > 0) {
            foundToolChunk = true;
            capturedToolCallId = delta.tool_calls[0].id;
          }
          if (json.choices?.[0]?.finish_reason === "tool_calls") {
            foundFinishChunk = true;
          }
        } catch {
          // ignore non-json
        }
      }
    }

    expect(foundToolChunk).toBe(true);
    expect(foundFinishChunk).toBe(true);
    expect(capturedToolCallId).toBeDefined();

    // ==========================================
    // 2. Responses API with tools
    // ==========================================
    const respApiRes = await request(app)
      .post("/v1/responses")
      .send({
        model: "antigravity:gemini-3.8-flash",
        input: [
          {
            type: "message",
            role: "user",
            content: "Call tool 'get_stream_telemetry' with channel='responses-api-channel'.",
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_stream_telemetry",
            description: "Fetch real-time telemetry metrics.",
            parameters: {
              type: "object",
              properties: {
                channel: { type: "string" },
              },
              required: ["channel"],
            },
          },
        ],
      });

    expect(respApiRes.status).toBe(200);
    const respBody = respApiRes.body;
    expect(respBody.output).toBeDefined();

    const functionCalls = (respBody.output as any[]).filter(
      (item) => item.type === "function_call",
    );
    expect(functionCalls.length).toBeGreaterThan(0);
    expect(functionCalls[0].name).toBe("get_stream_telemetry");
  }, 120000);
});

