import {
  ProviderRegistry,
  ProviderRouter,
  RuntimeExecutor,
} from "@agent-runtime-gateway/core";
import { CursorProvider } from "@agent-runtime-gateway/provider-cursor";
import { describe, expect, it } from "vitest";

const apiKey = process.env.CURSOR_API_KEY?.trim();
const describeIntegration = apiKey ? describe : describe.skip;

describeIntegration("CursorProvider integration", () => {
  it("lists models with a real Cursor API key", async () => {
    const provider = new CursorProvider({
      listingCredential: () => apiKey,
    });

    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.id.includes("composer"))).toBe(true);
  }, 60_000);

  it("executes a minimal real agent run", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new CursorProvider({
        listingCredential: () => apiKey,
        defaultWorkingDirectory: process.cwd(),
      }),
    );

    const executor = new RuntimeExecutor(new ProviderRouter(registry));
    const run = await executor.execute("cursor", {
      credential: { type: "cursor_api_key", value: apiKey ?? "" },
      model: "composer-2.5",
      sessionId: `integration-${Date.now()}`,
      message: "Reply with exactly the word pong and nothing else.",
    });

    const result = await run.wait();
    expect(result.status).toBe("completed");
    expect(result.output?.text?.toLowerCase()).toContain("pong");
  }, 180_000);
});
