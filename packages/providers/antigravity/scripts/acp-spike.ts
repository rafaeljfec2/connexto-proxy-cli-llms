/**
 * Antigravity ACP Runtime spike (demand FEAT-002).
 *
 * Runs the REAL `agy acp` end to end: spawn -> initialize -> authenticate
 * (local Google session reuse; no tokens cross the protocol) -> session/new ->
 * model selection -> text + PNG prompt -> session/list -> terminate ->
 * resume on a fresh process -> follow-up prompt -> shutdown.
 *
 * Usage:
 *   node packages/providers/antigravity/scripts/acp-spike.ts [workspaceDir]
 *
 * Redaction: tokens, authorization codes, and credential material are never
 * printed; output is limited to event kinds, stop reasons, usage counts, model
 * identifiers, and session ids.
 */
import fs from "node:fs";
import {
  AGY_CLI_PATH_ENV,
  AcpClient,
  DEFAULT_AGY_BINARY,
  defaultAgyPathCandidates,
  imageAndTextPrompt,
  textPrompt,
} from "@agent-runtime-gateway/provider-antigravity/acp";

const RED_8X8_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

function resolveAgyCommand(): string {
  const fromEnv = process.env[AGY_CLI_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  for (const candidate of defaultAgyPathCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_AGY_BINARY;
}

function printPhase(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function summarizeUsage(usage: unknown): string {
  if (usage === undefined || usage === null || typeof usage !== "object") {
    return "usage: not reported";
  }
  const record = usage as Record<string, unknown>;
  const tokenCount = (key: string): string => {
    const value = record[key];
    return typeof value === "number" ? String(value) : "?";
  };
  return (
    `usage: total=${tokenCount("totalTokens")}` +
    ` in=${tokenCount("inputTokens")}` +
    ` out=${tokenCount("outputTokens")}`
  );
}

type ModelOption = Awaited<ReturnType<AcpClient["setSessionConfig"]>>[number];

function logModelOptions(options: readonly ModelOption[]): void {
  for (const option of options) {
    if (option["category"] === "model") {
      console.log(
        `models: current=${String(option["currentValue"])}`,
        `values=${(option["options"] ?? []).map((value) => value["value"]).join(", ")}`,
      );
    }
  }
}

async function connectAndCreateSession(
  cwd: string,
): Promise<{ client: AcpClient; sessionId: string }> {
  const client = new AcpClient({
    command: resolveAgyCommand(),
    cwd,
    clientInfo: { name: "connexto-spike", version: "0.1.0" },
    timeouts: {
      initializeMs: 20_000,
      authMs: 120_000,
      promptTurnMs: 180_000,
      processGraceMs: 5_000,
    },
  });
  await client.connect();
  console.log(
    `connect: protocol=${client.protocolVersion} agent=${client.agentInfo.name} ${client.agentInfo.version}`,
  );
  console.log(`authMethods: ${client.authMethodIds.join(", ")}`);

  const created = await client.createSession(cwd);
  logModelOptions(created.configOptions ?? []);
  console.log(`sessionId: ${created.sessionId}`);
  return { client, sessionId: created.sessionId };
}

async function main(): Promise<void> {
  const cwd = process.argv[2] ?? process.cwd();
  printPhase("AGY ACP SPIKE");
  console.log(`workspace: ${cwd}`);
  console.log(`agy command: ${resolveAgyCommand()}`);

  printPhase("PHASE 1: connect + session/new (auth reuse)");
  const firstConnection = await connectAndCreateSession(cwd);
  const sessionId = firstConnection.sessionId;

  printPhase("PHASE 2: model selection (explicit)");
  {
    const updated = await firstConnection.client.setSessionConfig(
      sessionId,
      "model",
      "claude-sonnet-4-6",
    );
    logModelOptions(updated);
  }

  printPhase("PHASE 3: real text inference with streaming");
  {
    const events: string[] = [];
    const turn = await firstConnection.client.prompt(
      sessionId,
      textPrompt("Reply with exactly AGY-ACP-SPIKE-OK and nothing else."),
      { onEvent: (kind) => events.push(kind) },
    );
    console.log(`stopReason: ${turn.prompt.stopReason}`);
    console.log(`agentText: ${turn.agentText}`);
    console.log(summarizeUsage(turn.prompt.usage));
    console.log(`streamed event kinds: ${events.join(", ")}`);
  }

  printPhase("PHASE 4: PNG image + text prompt");
  {
    const events: string[] = [];
    const turn = await firstConnection.client.prompt(
      sessionId,
      imageAndTextPrompt(
        "image/png",
        RED_8X8_PNG_BASE64,
        "This PNG has a single dominant color. Answer with that one color word.",
      ),
      { onEvent: (kind) => events.push(kind) },
    );
    console.log(`stopReason: ${turn.prompt.stopReason}`);
    console.log(`agentText: ${turn.agentText}`);
    console.log(summarizeUsage(turn.prompt.usage));
    console.log(`streamed event kinds: ${events.join(", ")}`);
  }

  printPhase("PHASE 5: list sessions");
  {
    const listed = await firstConnection.client.listSessions();
    console.log(`sessions listed: ${listed.sessions.length}`);
  }

  printPhase("PHASE 6: terminate -> resume on fresh process");
  await firstConnection.client.terminate();
  console.log("terminate: ok");

  const secondConnection = await connectAndCreateSession(cwd);
  const resumed = await secondConnection.client.resumeSession(sessionId, cwd);
  console.log(`resume: ok (result keys: ${Object.keys(resumed).join(",") || "none"})`);
  {
    const turn = await secondConnection.client.prompt(
      sessionId,
      textPrompt(
        "Earlier in this conversation you were shown an image of one solid color. Reply now with only that color word, exactly as before.",
      ),
      { timeoutMs: 120_000 },
    );
    console.log(`resume prompt stopReason: ${turn.prompt.stopReason}`);
    console.log(summarizeUsage(turn.prompt.usage));
  }
  await secondConnection.client.terminate();
  console.log("final terminate: ok");

  printPhase("SPIKE COMPLETE");
}

main().catch((error: unknown) => {
  console.error(
    `SPIKE FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
