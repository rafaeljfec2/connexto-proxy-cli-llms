import {
  ProviderNotFoundError,
  ProviderRegistry,
  ProviderRouter,
} from "@agent-runtime-gateway/core";
import { describe, expect, it } from "vitest";
import { createStubProvider } from "./helpers/stub-provider.js";

describe("ProviderRouter", () => {
  it("resolves a registered provider through the registry", () => {
    const registry = new ProviderRegistry();
    const provider = createStubProvider("alpha");
    registry.register(provider);

    const router = new ProviderRouter(registry);

    expect(router.resolve("alpha")).toBe(provider);
  });

  it("propagates ProviderNotFoundError for unknown ids", () => {
    const router = new ProviderRouter(new ProviderRegistry());

    expect(() => router.resolve("unknown")).toThrow(ProviderNotFoundError);
  });
});
