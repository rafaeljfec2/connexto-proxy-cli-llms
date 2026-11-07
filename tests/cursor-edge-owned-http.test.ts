import { buildApp } from "@agent-runtime-gateway/api";
import { CursorProvider } from "../packages/providers/cursor/src/provider.js";
import hubComposerFixture from "../packages/compatibility/openai/tests/fixtures/codex/hub-composer-redacted.json" with { type: "json" };
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";

describe("Cursor edge-owned HTTP tool forwarding", () => {
  afterEach(() => resetGatewayServicesForTest());

  it("routes a hub tool call through the existing Responses SSE contract", async () => {
    const edgeOwnedRunner = vi.fn(() =>
      Promise.resolve({
        agentId: "edge-agent",
        runId: "edge-run",
        stream: (async function* () {
          await Promise.resolve();
          const toolCall = { name: "noop", arguments: {} };
          yield { type: "tool_call" as const, toolCall };
          yield { type: "done" as const, finalText: "", toolCalls: [toolCall] };
        })(),
      }),
    );
    const cursorProvider = new CursorProvider({ edgeOwnedRunner });
    initializeGatewayServices(
      { HOST: "127.0.0.1", SESSION_STORAGE_DRIVER: "memory" },
      { cursorProvider },
    );

    const response = await request(
      buildApp({
        HOST: "127.0.0.1",
        GATEWAY_API_TOKEN: "gateway-test-token",
        CURSOR_EXECUTION_MODE: "auto",
      }),
    )
      .post("/v1/responses")
      .set("X-Gateway-API-Key", "gateway-test-token")
      .set("Authorization", "Bearer cursor-test-key")
      .send({
        ...hubComposerFixture,
        instructions: hubComposerFixture.instructions.join("\n"),
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain("event: response.function_call_arguments.done");
    expect(response.text).toContain('"name":"noop"');
    expect(response.text).toContain("event: response.completed");
    expect(edgeOwnedRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "cursor-test-key",
        model: "composer-2.5",
        clientTools: [expect.objectContaining({ name: "noop" })],
      }),
    );
  });
});
