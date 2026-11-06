import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayServices } from "../apps/api/src/services/gateway.js";
import { loadEnv } from "../apps/api/src/config/env.js";
import type { AgentExecutionInput } from "@agent-runtime-gateway/core";
import { AntigravityProvider } from "@agent-runtime-gateway/provider-antigravity";
import type { CursorClient } from "@agent-runtime-gateway/provider-cursor";

describe("Gateway & Provider Session Persistence Across Restarts", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "connexto-gw-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
  });

  it("persists sessions across container/gateway restarts using filesystem driver", async () => {
    // 1. First Gateway instance (pre-restart)
    const env1 = loadEnv({
      HOST: "127.0.0.1",
      SESSION_STORAGE_DRIVER: "filesystem",
      SESSION_STORAGE_PATH: sessionDir,
    });

    const mockCreateAgent = vi.fn().mockResolvedValue({
      agentId: "cursor-agent-xyz-100",
      name: "test-cursor-agent",
    });

    const mockResumeAgent = vi.fn().mockResolvedValue({
      agentId: "cursor-agent-xyz-100",
      name: "test-cursor-agent",
    });

    const mockCursorClient = {
      createLocalAgent: mockCreateAgent,
      resumeLocalAgent: mockResumeAgent,
      listModels: vi.fn(),
    } as unknown as CursorClient;

    const mockAcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: "acp-session-abc-200" }),
      resumeSession: vi.fn().mockResolvedValue({}),
      setSessionConfig: vi.fn().mockResolvedValue([]),
      prompt: vi.fn(),
      cancelTurn: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    const services1 = createGatewayServices(env1);

    const antigravityProvider1 = new AntigravityProvider({
      clientFactory: () => mockAcpClient,
      sessionStore: services1.sessionStore as any,
    });

    // Acquire cursor session
    const cursorSessionManager1 = services1.cursorProvider.getSessionManager();
    (services1.cursorProvider as unknown as { client: CursorClient }).client =
      mockCursorClient;
    (cursorSessionManager1 as unknown as { client: CursorClient }).client =
      mockCursorClient;

    const acquiredCursorAgent = await cursorSessionManager1.acquireAgent(
      "user-gw-session-1",
      {
        apiKey: "test-key",
        model: "composer-2.5",
        name: "test-agent",
        workingDirectory: "/tmp",
      },
    );

    expect(acquiredCursorAgent.agentId).toBe("cursor-agent-xyz-100");
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);

    // Acquire antigravity session
    const fakeInput: AgentExecutionInput = {
      sessionId: "user-gw-session-1",
      model: "antigravity:gemini-3.8-flash",
      message: "Hello",
      credential: { type: "local", value: "" },
    };

    const run = await antigravityProvider1.execute(fakeInput);
    expect(run).toBeDefined();
    expect(mockAcpClient.createSession).toHaveBeenCalledTimes(1);

    // Verify files were persisted under sessionDir
    const cursorFile = path.join(sessionDir, "cursor", "user-gw-session-1.json");
    const antigravityFile = path.join(
      sessionDir,
      "antigravity",
      "user-gw-session-1.json",
    );

    const cursorData = JSON.parse(await fs.readFile(cursorFile, "utf8"));
    const antigravityData = JSON.parse(await fs.readFile(antigravityFile, "utf8"));

    expect(cursorData.agentId).toBe("cursor-agent-xyz-100");
    expect(antigravityData.acpSessionId).toBe("acp-session-abc-200");

    // 2. SIMULATE CONTAINER CRASH / RESTART: stop instance 1 completely
    services1.lifecycle.stop();

    // 3. Second Gateway instance (post-restart) pointing to the same storage path
    const env2 = loadEnv({
      HOST: "127.0.0.1",
      SESSION_STORAGE_DRIVER: "filesystem",
      SESSION_STORAGE_PATH: sessionDir,
    });

    const mockCreateAgent2 = vi.fn().mockResolvedValue({
      agentId: "unexpected-new-agent",
      name: "unexpected",
    });

    const mockResumeAgent2 = vi.fn().mockResolvedValue({
      agentId: "cursor-agent-xyz-100",
      name: "resumed-agent",
    });

    const mockCursorClient2 = {
      createLocalAgent: mockCreateAgent2,
      resumeLocalAgent: mockResumeAgent2,
      listModels: vi.fn(),
    } as unknown as CursorClient;

    const mockAcpClient2 = {
      connect: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: "unexpected-new-acp" }),
      resumeSession: vi.fn().mockResolvedValue({}),
      setSessionConfig: vi.fn().mockResolvedValue([]),
      prompt: vi.fn(),
      cancelTurn: vi.fn(),
      terminate: vi.fn().mockResolvedValue(undefined),
    };

    const services2 = createGatewayServices(env2);

    const antigravityProvider2 = new AntigravityProvider({
      clientFactory: () => mockAcpClient2,
      sessionStore: services2.sessionStore as any,
    });

    const cursorSessionManager2 = services2.cursorProvider.getSessionManager();
    (cursorSessionManager2 as unknown as { client: CursorClient }).client =
      mockCursorClient2;

    // In-memory cache is empty in instance 2 before read
    expect(cursorSessionManager2.getRemoteAgentId("user-gw-session-1")).toBeUndefined();

    // Re-acquire the same session ID
    const recoveredCursorAgent = await cursorSessionManager2.acquireAgent(
      "user-gw-session-1",
      {
        apiKey: "test-key",
        model: "composer-2.5",
        name: "test-agent",
        workingDirectory: "/tmp",
      },
    );

    // Should resume the existing agent from persistent storage!
    expect(mockResumeAgent2).toHaveBeenCalledTimes(1);
    expect(mockCreateAgent2).toHaveBeenCalledTimes(0);
    expect(recoveredCursorAgent.agentId).toBe("cursor-agent-xyz-100");

    // Execute with Antigravity provider using the same session
    await antigravityProvider2.execute(fakeInput);

    // Should resume the existing ACP session from persistent storage!
    expect(mockAcpClient2.resumeSession).toHaveBeenCalledWith(
      "acp-session-abc-200",
      expect.any(String),
    );
    expect(mockAcpClient2.createSession).toHaveBeenCalledTimes(0);

    services2.lifecycle.stop();
  });
});
