import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  AcpClient,
  AgentProcessTransport,
  AcpTimeoutError,
  AcpTurnInProgressError,
  imageAndTextPrompt,
  textPrompt,
} from "@agent-runtime-gateway/provider-antigravity/acp";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixture-agy.mjs",
);

const FAST_TIMEOUTS = {
  initializeMs: 4_000,
  authMs: 3_000,
  sessionLifecycleMs: 3_000,
  promptTurnMs: 6_000,
  processGraceMs: 2_000,
} as const;

interface Spawned {
  readonly client: AcpClient;
  readonly child: ChildProcess;
}

function makeClient(extraEnv: Record<string, string> = {}): Spawned {
  let childRef: ChildProcess | undefined;
  const client = new AcpClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: extraEnv,
    cwd: path.dirname(FIXTURE_PATH),
    timeouts: FAST_TIMEOUTS,
    spawnFn: (command, args, options) => {
      childRef = spawn(command, args, options);
      return childRef;
    },
  });
  return {
    client,
    get child(): ChildProcess {
      if (childRef === undefined) {
        throw new Error("fixture child process has not been spawned yet");
      }
      return childRef;
    },
  };
}

const keepAlive: AcpClient[] = [];

afterAll(async () => {
  for (const client of keepAlive.splice(0)) {
    await client.terminate().catch(() => undefined);
  }
});

describe("ACP client integration (fixture agent process)", () => {
  it("performs the initialize handshake with protocol version 1", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();

    expect(client.protocolVersion).toBe(1);
    expect(client.agentInfo.name).toBe("Fixtigravity ACP Server");
    expect(client.agentCapabilities["promptCapabilities"]).toMatchObject({
      image: true,
    });
  });

  it("rejects reconnecting while the existing agent process is still running", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();

    await expect(client.connect()).rejects.toThrow(/already connected/i);
    expect(client.isConnected).toBe(true);
    const { sessionId } = await client.createSession("/tmp");
    expect(sessionId).toBe("sess-fixture-1");
  });

  it("runs a text prompt turn with streamed intermediate events", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();

    const { sessionId } = await client.createSession("/tmp");
    const events: string[] = [];
    const turn = await client.prompt(sessionId, textPrompt("hello"), {
      timeoutMs: 6_000,
      onEvent: (kind) => events.push(kind),
    });

    expect(turn.prompt.stopReason).toBe("end_turn");
    expect(turn.agentText).toBe("FIXTURE-TURN-OK");
    expect(turn.thoughtText).toBe("thinking");
    expect(events).toContain("agent_message_chunk");
    expect(events).toContain("agent_thought_chunk");
    expect(events).toContain("tool_call");
    expect(events).toContain("plan");
  }, 20_000);

  it("ignores malformed session update notifications without throwing", async () => {
    const { client } = makeClient({ FIXTURE_MALFORMED_UPDATE: "1" });
    keepAlive.push(client);
    await client.connect();
    const { sessionId } = await client.createSession("/tmp");

    const turn = await client.prompt(sessionId, textPrompt("malformed update"));
    expect(turn.prompt.stopReason).toBe("end_turn");
    expect(turn.agentText).toBe("FIXTURE-TURN-OK");
  }, 15_000);

  it("retries session creation once after auth_required via oauth-personal", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();

    const { sessionId } = await client.createSession("/tmp");
    expect(sessionId).toBe("sess-fixture-1");
    expect(client.authMethodIds).toContain("oauth-personal");
  }, 15_000);

  it("sends text+image content blocks and discovers/sets session config", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();

    const created = await client.createSession("/tmp");
    const modelOption = created.configOptions?.find((option) => option.id === "model");
    expect(modelOption?.currentValue).toBe("fixture-flash");

    const updated = await client.setSessionConfig(
      created.sessionId,
      "model",
      "fixture-pro",
    );
    expect(updated.find((option) => option.id === "model")?.currentValue).toBe(
      "fixture-pro",
    );

    const events: string[] = [];
    await client.prompt(
      created.sessionId,
      imageAndTextPrompt("image/png", "AAAA", "what color?"),
      {
        onEvent: (kind) => events.push(kind),
      },
    );
    expect(agentAnswered(events)).toBe(true);
  }, 20_000);

  it("lists sessions and resumes one across a fresh connection", async () => {
    const first = makeClient();
    keepAlive.push(first.client);
    await first.client.connect();
    const { sessionId } = await first.client.createSession("/tmp");
    await first.client.terminate();

    const second = makeClient();
    keepAlive.push(second.client);
    await second.client.connect();
    const listed = await second.client.listSessions();
    expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);

    await expect(second.client.resumeSession(sessionId, "/tmp")).resolves.toMatchObject(
      {},
    );
  }, 20_000);

  it("surfaces stderr noise and invalid stdout lines without breaking the protocol", async () => {
    const invalid: string[] = [];
    let stderrText = "";
    let resolveStderr: (() => void) | undefined;
    const stderrSeen = new Promise<void>((resolve) => {
      resolveStderr = resolve;
    });
    const client = new AcpClient({
      command: process.execPath,
      args: [FIXTURE_PATH],
      env: { FIXTURE_OUTPUT_GARBAGE: "1" },
      cwd: path.dirname(FIXTURE_PATH),
      timeouts: FAST_TIMEOUTS,
      onInvalidLine: (line) => invalid.push(line),
      spawnFn: (command, args, options) => {
        const child = spawn(command, args, options);
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderrText += chunk;
          resolveStderr?.();
        });
        return child;
      },
    });
    keepAlive.push(client);
    await client.connect();
    await stderrSeen;

    expect(invalid).toContain("not-a-json-line-noise");
    expect(stderrText).toContain("FIXTURE-STDERR-NOISE");
    const { sessionId } = await client.createSession("/tmp");
    expect(sessionId).toBe("sess-fixture-1");
  }, 20_000);

  it("drains large stderr output without blocking the ACP process", async () => {
    const { client } = makeClient({ FIXTURE_STDERR_BURST: "1" });
    keepAlive.push(client);
    await client.connect();

    const { sessionId } = await client.createSession("/tmp");
    expect(sessionId).toBe("sess-fixture-1");
  }, 15_000);

  it("rejects with AcpTimeoutError when the agent never answers initialize", async () => {
    const client = new AcpClient({
      command: process.execPath,
      args: [FIXTURE_PATH],
      env: { FIXTURE_HANG: "1" },
      cwd: path.dirname(FIXTURE_PATH),
      timeouts: { ...FAST_TIMEOUTS, initializeMs: 600, processGraceMs: 800 },
    });
    keepAlive.push(client);

    await expect(client.connect()).rejects.toBeInstanceOf(AcpTimeoutError);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  it("uses the client prompt timeout when no per-call timeout is supplied", async () => {
    let resolveCancelAck: (() => void) | undefined;
    const cancelAck = new Promise<void>((resolve) => {
      resolveCancelAck = resolve;
    });
    const client = new AcpClient({
      command: process.execPath,
      args: [FIXTURE_PATH],
      env: { FIXTURE_NO_CANCEL: "1" },
      cwd: path.dirname(FIXTURE_PATH),
      timeouts: { ...FAST_TIMEOUTS, promptTurnMs: 200 },
      onNotification: (method, params) => {
        const update = (params as { update?: { sessionUpdate?: string } } | undefined)
          ?.update;
        if (method === "session/update" && update?.sessionUpdate === "cancel_ack") {
          resolveCancelAck?.();
        }
      },
    });
    keepAlive.push(client);
    await client.connect();
    const { sessionId } = await client.createSession("/tmp");

    await expect(
      client.prompt(sessionId, textPrompt("must time out")),
    ).rejects.toBeInstanceOf(AcpTimeoutError);
    await cancelAck;
  }, 15_000);

  it("does not inherit arbitrary host secrets into the agent environment", async () => {
    const secretKey = "ACP_TEST_CREDENTIAL";
    const originalValue = process.env[secretKey];
    process.env[secretKey] = "not-for-the-agent";
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const client = new AcpClient({
      command: process.execPath,
      args: [FIXTURE_PATH],
      cwd: path.dirname(FIXTURE_PATH),
      env: { FIXTURE_EXPLICIT_ENV: "per-client" },
      timeouts: FAST_TIMEOUTS,
      spawnFn: (command, args, options) => {
        childEnvironment = options.env;
        return spawn(command, args, options);
      },
    });
    try {
      await client.connect();
      expect(childEnvironment).not.toHaveProperty(secretKey);
      expect(childEnvironment).toHaveProperty("FIXTURE_EXPLICIT_ENV", "per-client");
      if (process.env["HOME"] !== undefined) {
        expect(childEnvironment).toHaveProperty("HOME", process.env["HOME"]);
      }
    } finally {
      await client.terminate();
      if (originalValue === undefined) {
        delete process.env[secretKey];
      } else {
        process.env[secretKey] = originalValue;
      }
    }
  }, 15_000);

  it("returns from terminate if the process already exited by signal", async () => {
    let childRef: ChildProcess | undefined;
    const transport = new AgentProcessTransport({
      command: process.execPath,
      args: [FIXTURE_PATH],
      cwd: path.dirname(FIXTURE_PATH),
      spawnFn: (command, args, options) => {
        childRef = spawn(command, args, options);
        return childRef;
      },
    });
    transport.start();
    await transport.request(1, "initialize", {}, 3_000);

    const child = childRef;
    if (child === undefined) {
      throw new Error("fixture child process was not spawned");
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;

    await expect(transport.terminate(100)).resolves.toBeUndefined();
    expect(transport.isRunning).toBe(false);
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "kills a descendant process when the ACP agent exits unexpectedly",
    async () => {
      let childRef: ChildProcess | undefined;
      let resolveDescendant: ((pid: number) => void) | undefined;
      const descendantPid = new Promise<number>((resolve) => {
        resolveDescendant = resolve;
      });
      const transport = new AgentProcessTransport({
        command: process.execPath,
        args: [FIXTURE_PATH],
        env: { FIXTURE_SPAWN_ORPHAN: "1" },
        cwd: path.dirname(FIXTURE_PATH),
        spawnFn: (command, args, options) => {
          childRef = spawn(command, args, options);
          return childRef;
        },
      });
      transport.onNotification((method, params) => {
        if (method !== "fixture/descendant") {
          return;
        }
        const pid = (params as { pid?: unknown } | undefined)?.pid;
        if (typeof pid === "number") {
          resolveDescendant?.(pid);
        }
      });
      transport.start();
      const root = childRef;
      if (root === undefined) {
        throw new Error("fixture root process was not spawned");
      }
      const rootExit = new Promise<void>((resolve) =>
        root.once("exit", () => resolve()),
      );
      await transport.request(1, "initialize", {}, 3_000);

      const pid = await descendantPid;
      await rootExit;
      await transport.terminate(100);
      await expectProcessExit(pid);
    },
    15_000,
  );

  it("rejects with a typed protocol error on handshake failure", async () => {
    const { client } = makeClient({ FIXTURE_HANDSHAKE_FAIL: "1" });
    keepAlive.push(client);

    await expect(client.connect()).rejects.toThrow(/initialize failed/);
    expect(client.isConnected).toBe(false);
  }, 15_000);

  it("reports unexpected process exit while a prompt is in flight", async () => {
    const spawned = makeClient({ FIXTURE_CRASH_ON_PROMPT: "1" });
    keepAlive.push(spawned.client);
    await spawned.client.connect();
    const { sessionId } = await spawned.client.createSession("/tmp");
    const child = spawned.child;

    const exitPromise = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    await expect(
      spawned.client.prompt(sessionId, textPrompt("kill me")),
    ).rejects.toThrow(/exited|crash|process/i);
    await exitPromise;
    expect(child.exitCode).toBe(3);
    expect(spawned.client.isConnected).toBe(false);
  }, 20_000);

  it("recovers with a new client after an unexpected agent crash", async () => {
    const crashed = makeClient({ FIXTURE_CRASH_ON_PROMPT: "1" });
    await crashed.client.connect();
    const { sessionId } = await crashed.client.createSession("/tmp");
    await expect(
      crashed.client.prompt(sessionId, textPrompt("boom")),
    ).rejects.toThrow();
    await crashed.client.terminate();

    const recovered = makeClient();
    keepAlive.push(recovered.client);
    await recovered.client.connect();
    const { sessionId: newSessionId } = await recovered.client.createSession("/tmp");
    const turn = await recovered.client.prompt(newSessionId, textPrompt("again"));
    expect(turn.prompt.stopReason).toBe("end_turn");
  }, 25_000);

  it("delivers a cancelled stopReason after session/cancel", async () => {
    const { client } = makeClient({ FIXTURE_NO_CANCEL: "1" });
    keepAlive.push(client);
    await client.connect();

    const { sessionId } = await client.createSession("/tmp");
    const promptPromise = client.prompt(sessionId, textPrompt("long running"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.cancelTurn(sessionId);

    const turn = await promptPromise;
    expect(turn.prompt.stopReason).toBe("cancelled");
  }, 20_000);

  it("rejects concurrent prompt turns on one ACP client", async () => {
    const { client } = makeClient({ FIXTURE_NO_CANCEL: "1" });
    keepAlive.push(client);
    await client.connect();
    const { sessionId } = await client.createSession("/tmp");
    const activeTurn = client.prompt(sessionId, textPrompt("active turn"));

    await expect(
      client.prompt(sessionId, textPrompt("overlapping turn")),
    ).rejects.toBeInstanceOf(AcpTurnInProgressError);
    client.cancelTurn(sessionId);
    await expect(activeTurn).resolves.toMatchObject({
      prompt: { stopReason: "cancelled" },
    });
  }, 20_000);

  it("terminates cleanly without leaving the process group alive", async () => {
    const spawned = makeClient();
    await spawned.client.connect();
    const child = spawned.child;

    await spawned.client.terminate();

    const exited =
      child.exitCode === 0 ||
      child.signalCode === "SIGINT" ||
      child.signalCode === "SIGKILL";
    expect(exited).toBe(true);
    expect(spawned.client.isConnected).toBe(false);
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  }, 15_000);

  it("resumes a session and forwards its context to prompts", async () => {
    const { client } = makeClient();
    keepAlive.push(client);
    await client.connect();
    const { sessionId } = await client.createSession("/tmp");
    await client.prompt(sessionId, textPrompt("setup context"));

    const listed = await client.listSessions();
    expect(listed.sessions.length).toBeGreaterThan(0);
    await expect(
      client.resumeSession("sess-fixture-1-missing", "/tmp"),
    ).rejects.toThrow(/Unknown session/i);
    await expect(client.resumeSession(sessionId, "/tmp")).resolves.toMatchObject({});
  }, 20_000);

  it("supports the full knowledge: image prompts compile to content blocks", () => {
    const blocks = imageAndTextPrompt("image/jpeg", "AQID", "describe");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "text", text: "describe" });
    expect(blocks[1]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: "AQID",
    });
  });
});

function agentAnswered(events: string[]): boolean {
  return events.includes("agent_message_chunk");
}

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`descendant process ${pid} remained alive after agent termination`);
}
