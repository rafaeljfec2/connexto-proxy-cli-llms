import { describe, expect, it } from "vitest";
import { resolveProviderTarget } from "./provider-target.js";

describe("resolveProviderTarget", () => {
  it("preserves existing Cursor defaults and aliases", () => {
    expect(resolveProviderTarget(undefined)).toEqual({
      providerId: "cursor",
      modelId: "composer-2.5",
      credentialType: "api_key",
    });
    expect(resolveProviderTarget("composer-latest")).toEqual({
      providerId: "cursor",
      modelId: "composer-2.5",
      credentialType: "api_key",
    });
  });

  it("routes a namespaced Antigravity model to its underlying ACP model", () => {
    expect(resolveProviderTarget("antigravity:claude-sonnet-4-6")).toEqual({
      providerId: "antigravity",
      modelId: "antigravity:claude-sonnet-4-6",
      credentialType: "local",
    });
  });

  it("rejects unknown Antigravity models instead of forwarding them to Cursor", () => {
    expect(() => resolveProviderTarget("antigravity:unknown-model")).toThrow(
      /model.*does not exist/i,
    );
  });
});
