import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import readline from "node:readline";
import {
  AntigravityMcpBridge,
  sanitizeMcpToolSchema,
} from "../src/mcp/index.js";

describe("Antigravity MCP Bridge Server", () => {
  let bridge: AntigravityMcpBridge | undefined;

  afterEach(async () => {
    if (bridge) {
      await bridge.dispose();
      bridge = undefined;
    }
  });

  it("sanitizes OpenAI parameter schemas to MCP inputSchema safely", () => {
    expect(sanitizeMcpToolSchema(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMcpToolSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeMcpToolSchema([1, 2])).toEqual({ type: "object", properties: {} });

    const openAiSchema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    };
    const sanitized = sanitizeMcpToolSchema(openAiSchema);
    expect(sanitized).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("handles lifecycle, tool discovery, and Option A delegation over IPC socket", async () => {
    const toolCallsSeen: string[] = [];
    const toolResultsSeen: string[] = [];

    bridge = new AntigravityMcpBridge({
      sessionId: "test-sess-1",
      tools: [
        {
          name: "get_current_test_context",
          description: "Retrieve test context",
          parameters: {
            type: "object",
            properties: { testKey: { type: "string" } },
            required: ["testKey"],
          },
        },
      ],
      onToolCall: (call) => toolCallsSeen.push(call.name),
      onToolResult: (callId, res) => toolResultsSeen.push(callId),
    });

    const mcpConfig = await bridge.start();
    expect(mcpConfig.name).toBe("connexto_tools");
    expect(mcpConfig.command).toBe("node");
    expect(mcpConfig.args.length).toBe(2);

    const socketPath = bridge.socketAddress;
    expect(fs.existsSync(socketPath)).toBe(true);

    const client = net.connect(socketPath);
    const rl = readline.createInterface({ input: client, terminal: false });

    const responses: any[] = [];
    rl.on("line", (line) => {
      responses.push(JSON.parse(line));
    });

    // 1. Send server/discover
    client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(responses[0]).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });

    // 2. Send initialize
    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(responses[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
      },
    });

    // 3. Send tools/list
    client.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(responses[2].result.tools).toHaveLength(1);
    expect(responses[2].result.tools[0].name).toBe("get_current_test_context");

    // 4. Send tools/call (Option A delegation)
    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_current_test_context",
          arguments: { testKey: "val123" },
        },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(responses[3].id).toBe(4);
    expect(responses[3].result.isError).toBe(false);
    expect(responses[3].result.content[0].text).toContain("DELEGATED_TO_CLIENT");

    expect(toolCallsSeen).toEqual(["get_current_test_context"]);
    expect(toolResultsSeen).toHaveLength(1);

    client.destroy();
    await bridge.dispose();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("supports custom executor when provided", async () => {
    bridge = new AntigravityMcpBridge({
      sessionId: "test-sess-exec",
      tools: [{ name: "calc" }],
      executor: async (call) => ({
        output: JSON.stringify({ calcResult: 42 }),
      }),
    });

    await bridge.start();
    const client = net.connect(bridge.socketAddress);
    const rl = readline.createInterface({ input: client, terminal: false });

    const responses: any[] = [];
    rl.on("line", (line) => responses.push(JSON.parse(line)));

    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "calc", arguments: {} },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[0].result.isError).toBe(false);
    expect(responses[0].result.content[0].text).toContain('"calcResult":42');

    client.destroy();
  });

  it("enforces default safe denial for unknown tools without policy", async () => {
    bridge = new AntigravityMcpBridge({
      sessionId: "test-sess-denial",
      tools: [],
    });

    await bridge.start();
    const client = net.connect(bridge.socketAddress);
    const rl = readline.createInterface({ input: client, terminal: false });

    const responses: any[] = [];
    rl.on("line", (line) => responses.push(JSON.parse(line)));

    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "unknown_dangerous_tool", arguments: {} },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[0].result.isError).toBe(true);
    expect(responses[0].result.content[0].text).toContain(
      "Permission denied: tool 'unknown_dangerous_tool' has no declared authorization policy",
    );

    client.destroy();
  });

  it("enforces explicit denial policy for declared tools", async () => {
    bridge = new AntigravityMcpBridge({
      sessionId: "test-sess-policy-deny",
      tools: [{ name: "forbidden_tool" }],
      policies: {
        forbidden_tool: {
          permissionLevel: "destructive",
          allowed: false,
        },
      },
    });

    await bridge.start();
    const client = net.connect(bridge.socketAddress);
    const rl = readline.createInterface({ input: client, terminal: false });

    const responses: any[] = [];
    rl.on("line", (line) => responses.push(JSON.parse(line)));

    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "forbidden_tool", arguments: {} },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[0].result.isError).toBe(true);
    expect(responses[0].result.content[0].text).toContain(
      "Permission denied: execution of tool 'forbidden_tool' is explicitly rejected by policy",
    );

    client.destroy();
  });

  it("handles discovery and execution across multiple declared tools", async () => {
    const callsReceived: string[] = [];
    bridge = new AntigravityMcpBridge({
      sessionId: "test-sess-multi",
      tools: [
        {
          name: "get_weather",
          description: "Get weather for city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        {
          name: "calculate_distance",
          description: "Calculate distance between points",
          parameters: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
          },
        },
      ],
      onToolCall: (call) => callsReceived.push(call.name),
    });

    await bridge.start();
    const client = net.connect(bridge.socketAddress);
    const rl = readline.createInterface({ input: client, terminal: false });

    const responses: any[] = [];
    rl.on("line", (line) => responses.push(JSON.parse(line)));

    // 1. tools/list should list both tools
    client.write(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/list" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[0].result.tools).toHaveLength(2);
    expect(responses[0].result.tools.map((t: any) => t.name)).toEqual([
      "get_weather",
      "calculate_distance",
    ]);

    // 2. call tool 1
    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "get_weather", arguments: { city: "Curitiba" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[1].result.content[0].text).toContain("[DELEGATED_TO_CLIENT: tool_call_id=");
    expect(callsReceived).toContain("get_weather");

    // 3. call tool 2
    client.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "calculate_distance", arguments: { from: "A", to: "B" } },
      }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(responses[2].result.content[0].text).toContain("[DELEGATED_TO_CLIENT: tool_call_id=");
    expect(callsReceived).toContain("calculate_distance");

    client.destroy();
  });
});
