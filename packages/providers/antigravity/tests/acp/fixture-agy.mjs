#!/usr/bin/env node
// Test fixture: emulates the observed behavior of `agy acp` (version 1.5.1)
// for integration tests. Driven entirely by environment flags.
// Not part of the product; never runs with real Google credentials.
import readline from "node:readline";
import { spawn } from "node:child_process";

const FLAG = {
  HANDSHAKE_FAIL: process.env["FIXTURE_HANDSHAKE_FAIL"] === "1",
  HANG: process.env["FIXTURE_HANG"] === "1",
  GARBAGE: process.env["FIXTURE_OUTPUT_GARBAGE"] === "1",
  STDERR_BURST: process.env["FIXTURE_STDERR_BURST"] === "1",
  MALFORMED_UPDATE: process.env["FIXTURE_MALFORMED_UPDATE"] === "1",
  SPAWN_ORPHAN: process.env["FIXTURE_SPAWN_ORPHAN"] === "1",
  CRASH_ON_PROMPT: process.env["FIXTURE_CRASH_ON_PROMPT"] === "1",
  EXIT_AFTER_INIT: process.env["FIXTURE_EXIT_AFTER_INIT"] === "1",
  NO_CANCEL: process.env["FIXTURE_NO_CANCEL"] === "1",
};

const state = {
  authenticated: false,
  pendingPrompt: null, // { sessionId, id }
  sessionCount: 0,
};

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const CAPABILITIES = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { resume: {}, close: {}, list: {} },
  },
  agentInfo: { name: "Fixtigravity ACP Server", version: "0.0.0-test" },
  authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
};

function update(sessionId, sessionUpdate, extra = {}) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate, ...extra } },
  };
}

function agentChunks(text, sessionId) {
  const middle = Math.floor(text.length / 2);
  return [
    update(sessionId, "user_message_chunk", {
      content: { type: "text", text: "user:" },
    }),
    update(sessionId, "agent_thought_chunk", {
      content: { type: "text", text: "thinking" },
    }),
    update(sessionId, "tool_call", {
      toolCallId: "call-1",
      title: "fixture tool",
      kind: "other",
      status: "pending",
    }),
    update(sessionId, "agent_message_chunk", {
      messageId: "m1",
      content: { type: "text", text: text.slice(0, middle) },
    }),
    update(sessionId, "agent_message_chunk", {
      messageId: "m1",
      content: { type: "text", text: text.slice(middle) },
    }),
    update(sessionId, "plan", {
      entries: [{ content: "finish", priority: "high", status: "completed" }],
    }),
  ];
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 2,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  thoughtTokens: 1,
  totalTokens: 13,
};

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;

  if (method === "initialize") {
    if (FLAG.HANDSHAKE_FAIL) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "fixture handshake failure" },
      });
    } else {
      write({ jsonrpc: "2.0", id, result: CAPABILITIES });
      if (FLAG.SPAWN_ORPHAN) {
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            stdio: "ignore",
          },
        );
        descendant.unref();
        write({
          jsonrpc: "2.0",
          method: "fixture/descendant",
          params: { pid: descendant.pid },
        });
        setTimeout(() => process.exit(0), 100);
      }
      if (FLAG.EXIT_AFTER_INIT) {
        process.exit(0);
      }
    }
    return;
  }
  if (method === "authenticate") {
    state.authenticated = true;
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/new") {
    if (!state.authenticated) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "Authentication required" },
      });
      return;
    }
    state.sessionCount += 1;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: `sess-fixture-${state.sessionCount}`,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "fixture-flash",
            options: [
              { value: "fixture-flash", name: "Fixture Flash" },
              { value: "fixture-pro", name: "Fixture Pro" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (method === "session/set_config_option") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: String(params["value"]),
            options: [
              { value: "fixture-flash", name: "Fixture Flash" },
              { value: "fixture-pro", name: "Fixture Pro" },
            ],
          },
        ],
      },
    });
    return;
  }
  if (method === "session/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: { sessions: [{ sessionId: "sess-fixture-1" }] },
    });
    return;
  }
  if (method === "session/resume") {
    if (String(params["sessionId"]).endsWith("-missing")) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32002, message: "Unknown session" },
      });
    } else {
      write({ jsonrpc: "2.0", id, result: {} });
    }
    return;
  }
  if (method === "session/cancel") {
    state.pendingPrompt = null;
    write(update(params["sessionId"], "cancel_ack"));
    write({
      jsonrpc: "2.0",
      id: state.capturedPromptId ?? -1,
      result: { stopReason: "cancelled" },
    });
    return;
  }
  if (method === "session/close") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/prompt") {
    if (state.pendingPrompt !== null) {
      // previous turn still open (cancel test); ignore double turn
    }
    const sessionId = params["sessionId"];
    promptTurn(id, sessionId, params, FLAG.NO_CANCEL);
    return;
  }
  write({
    jsonrpc: "2.0",
    id: id ?? -1,
    error: { code: -32601, message: "unknown fixture method" },
  });
}

function promptTurn(id, sessionId, params, noCancel) {
  state.pendingPrompt = { sessionId, id };
  state.capturedPromptId = id;
  if (FLAG.CRASH_ON_PROMPT) {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m0",
          content: { type: "text", text: "start" },
        },
      },
    });
    process.exit(3);
  }
  if (FLAG.MALFORMED_UPDATE) {
    write({ jsonrpc: "2.0", method: "session/update" });
  }
  const text = "FIXTURE-TURN-OK";
  for (const update of agentChunks(text, sessionId)) {
    write(update);
  }
  if (!noCancel) {
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: USAGE } });
  }
}

function main() {
  if (FLAG.HANG) {
    process.stdin.resume();
    return;
  }
  if (FLAG.STDERR_BURST) {
    process.stderr.write(Buffer.alloc(1024 * 1024, 120));
  }
  if (FLAG.GARBAGE) {
    process.stdout.write("not-a-json-line-noise\n");
    process.stderr.write("FIXTURE-STDERR-NOISE\n");
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", handle);
  rl.on("close", () => process.exit(0));
}

main();
