import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AntigravityProvider } from "@agent-runtime-gateway/provider-antigravity";
import {
  AGY_CLI_PATH_ENV,
  ACP_PROTOCOL_VERSION,
  AcpClient,
  defaultAgyPathCandidates,
  textPrompt,
} from "@agent-runtime-gateway/provider-antigravity/acp";

/**
 * REAL Antigravity ACP runtime check (offline by default).
 *
 * Runs the official `agy acp` subprocess: spawn -> initialize (protocol 1) ->
 * authenticate by reusing the locally authenticated Google session ->
 * session/new -> real text inference with streamed updates -> terminate.
 *
 * No credential material is exported, transported, or logged. Gated by
 * RUN_ANTIGRAVITY_ACP_TESTS=1 (opt-in) and a resolvable `agy` binary
 * (AGY_PATH env or ~/.gemini/bin/agy), so offline CI is unaffected.
 */
const RUN_REAL = process.env["RUN_ANTIGRAVITY_ACP_TESTS"] === "1";

function resolveAgyPath(): string | undefined {
  const fromEnv = process.env[AGY_CLI_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return defaultAgyPathCandidates().find((candidate) => fs.existsSync(candidate));
}

const agyPath = resolveAgyPath();
const SPIKE_TIMEOUT = 240_000;
const realWorkspacesRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const workspace = join(realWorkspacesRoot, "agy-acp-workspace");

function ensureWorkspace(): string {
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

const liveClients: AcpClient[] = [];

afterAll(async () => {
  for (const client of liveClients.splice(0)) {
    await client.terminate().catch(() => undefined);
  }
});

describe.skipIf(!(RUN_REAL && agyPath !== undefined))(
  "Antigravity ACP real runtime (opt-in, real CLI)",
  () => {
    it(
      "authenticates via the local Google session and performs a real streaming inference",
      async () => {
        const cwd = ensureWorkspace();
        const client = new AcpClient({
          command: agyPath!,
          cwd,
          clientInfo: { name: "connexto-real-test", version: "0.1.0" },
          timeouts: {
            initializeMs: 30_000,
            authMs: 180_000,
            promptTurnMs: 180_000,
            processGraceMs: 5_000,
          },
        });
        liveClients.push(client);

        await client.connect();
        expect(client.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

        const { sessionId } = await client.createSession(cwd);
        expect(typeof sessionId).toBe("string");
        expect(sessionId.length).toBeGreaterThan(0);

        const events: string[] = [];
        const turn = await client.prompt(
          sessionId,
          textPrompt("Reply with exactly CONNEXO-ACP-REAL-OK and nothing else."),
          { onEvent: (kind) => events.push(kind) },
        );

        expect(turn.prompt.stopReason).toBe("end_turn");
        expect(turn.agentText).toContain("CONNEXO-ACP-REAL-OK");
        expect(events).toContain("agent_message_chunk");
        expect(client.agentCapabilities["promptCapabilities"] !== undefined).toBe(true);

        await client.terminate();
        expect(client.isConnected).toBe(false);
      },
      SPIKE_TIMEOUT,
    );

    it(
      "executes a gateway AgentRun through the real Antigravity provider",
      async () => {
        const cwd = ensureWorkspace();
        const provider = new AntigravityProvider({ defaultWorkingDirectory: cwd });
        const run = await provider.execute({
          credential: { type: "local", value: "" },
          model: "antigravity:gemini-3.8-flash",
          sessionId: `real-provider-${Date.now()}`,
          message: "Reply with exactly CONNEXO-ACP-PROVIDER-OK and nothing else.",
          workingDirectory: cwd,
        });
        const events: string[] = [];
        for await (const event of run.events) {
          events.push(event.type);
        }
        const result = await run.wait();

        expect(result.status).toBe("completed");
        expect(result.output?.text).toContain("CONNEXO-ACP-PROVIDER-OK");
        expect(events).toContain("message.delta");
        expect(events).toContain("run.completed");
      },
      SPIKE_TIMEOUT,
    );
  },
);
