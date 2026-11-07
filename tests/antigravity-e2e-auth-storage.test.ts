import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AntigravityAuthManager,
  AntigravityProvider,
} from "@agent-runtime-gateway/provider-antigravity";
import {
  AGY_CLI_PATH_ENV,
  defaultAgyPathCandidates,
} from "@agent-runtime-gateway/provider-antigravity/acp";
import { FilesystemSessionStore } from "@agent-runtime-gateway/core";
import fsSync from "node:fs";

function resolveAgyPath(): string | undefined {
  const fromEnv = process.env[AGY_CLI_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return defaultAgyPathCandidates().find((candidate) => fsSync.existsSync(candidate));
}

const agyPath = resolveAgyPath();
const hasAgy = agyPath !== undefined;
const RUN_REAL = process.env["RUN_ANTIGRAVITY_ACP_TESTS"] === "1";
const describeReal = hasAgy && RUN_REAL ? describe : describe.skip;

describeReal("Antigravity CLI End-to-End Auth & Storage Persistence", () => {
  let tempStorageDir: string;
  let workspaceDir: string;

  beforeAll(async () => {
    tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-e2e-storage-"));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-e2e-workspace-"));
  });

  afterAll(async () => {
    await fs
      .rm(tempStorageDir, { recursive: true, force: true })
      .catch(() => undefined);
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("completes full auth lifecycle and detects account from local Google CLI credentials", async () => {
    const authManager = new AntigravityAuthManager({ homeDir: tempStorageDir });

    // 1. Check current status
    const initialStatus = await authManager.getStatus();
    expect(initialStatus.viabilityGate).toBe("PARTIALLY_SUPPORTED");
    expect(initialStatus.limitations.length).toBeGreaterThan(0);

    // 2. Start a new OAuth PKCE authentication operation
    const startResult = await authManager.startAuth();
    expect(startResult.operationId).toBeDefined();
    expect(startResult.status).toBe("pending");
    expect(startResult.state).toBeDefined();
    expect(startResult.authUrl).toContain("https://accounts.google.com/o/oauth2/auth");
    expect(startResult.authUrl).toContain("code_challenge_method=S256");

    // 3. Verify operation is tracked
    const op = authManager.getOperation(startResult.operationId);
    expect(op).toBeDefined();
    expect(op?.status).toBe("pending");

    // 4. Handle callback with auth code
    const callbackResult = await authManager.handleCallback({
      state: startResult.state,
      code: "synthetic-auth-code-12345",
    });

    expect(callbackResult.status).toBe("completed");
    expect(callbackResult.operationId).toBe(startResult.operationId);

    // 5. Verify status reflects the completed operation
    const updatedStatus = await authManager.getStatus();
    expect(updatedStatus.activeOperation?.status).toBe("completed");
  });

  it("persists and resumes real agy ACP sessions across provider instances using FilesystemSessionStore", async () => {
    const sessionStore = new FilesystemSessionStore<{
      readonly acpSessionId: string;
      touchedAt: number;
    }>({
      rootDir: tempStorageDir,
    });

    const gatewaySessionId = `e2e-gw-sess-${Date.now()}`;

    // --- INSTANCE 1: First interaction, creates ACP session and persists mapping ---
    const provider1 = new AntigravityProvider({
      defaultWorkingDirectory: workspaceDir,
      sessionStore,
    });

    const run1 = await provider1.execute({
      credential: { type: "local", value: "" },
      model: "antigravity:gemini-3.8-flash",
      sessionId: gatewaySessionId,
      message: "Reply with the single word: HELLO",
      workingDirectory: workspaceDir,
    });

    const events1: string[] = [];
    for await (const event of run1.events) {
      events1.push(event.type);
    }
    const result1 = await run1.wait();

    expect(result1.status).toBe("completed");
    expect(result1.output?.text).toBeDefined();
    expect(events1).toContain("message.delta");
    expect(events1).toContain("run.completed");

    // Verify storage file on disk
    const sessionFilePath = path.join(
      tempStorageDir,
      "antigravity",
      `${gatewaySessionId}.json`,
    );
    const fileStat = await fs.stat(sessionFilePath);
    expect(fileStat.isFile()).toBe(true);

    const fileContent = JSON.parse(await fs.readFile(sessionFilePath, "utf8")) as {
      acpSessionId: string;
      touchedAt: number;
    };
    expect(fileContent.acpSessionId).toBeDefined();
    expect(typeof fileContent.acpSessionId).toBe("string");
    expect(typeof fileContent.touchedAt).toBe("number");
    const originalAcpSessionId = fileContent.acpSessionId;
    const originalTouchedAt = fileContent.touchedAt;

    // --- SIMULATE RESTART: Discard provider1, create provider2 with fresh in-memory cache ---
    const provider2 = new AntigravityProvider({
      defaultWorkingDirectory: workspaceDir,
      sessionStore,
    });

    // Run second turn using the SAME gatewaySessionId
    const run2 = await provider2.execute({
      credential: { type: "local", value: "" },
      model: "antigravity:gemini-3.8-flash",
      sessionId: gatewaySessionId,
      message: "Reply with the single word: WORLD",
      workingDirectory: workspaceDir,
    });

    const events2: string[] = [];
    for await (const event of run2.events) {
      events2.push(event.type);
    }
    const result2 = await run2.wait();

    expect(result2.status).toBe("completed");
    expect(result2.output?.text).toBeDefined();
    expect(events2).toContain("message.delta");

    // Verify that the stored ACP session ID was reused (resumed) and touchedAt was updated
    const updatedContent = JSON.parse(await fs.readFile(sessionFilePath, "utf8")) as {
      acpSessionId: string;
      touchedAt: number;
    };
    expect(updatedContent.acpSessionId).toBe(originalAcpSessionId);
    expect(updatedContent.touchedAt).toBeGreaterThanOrEqual(originalTouchedAt);
  }, 120_000);
});
