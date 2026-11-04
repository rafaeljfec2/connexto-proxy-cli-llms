import {
  InvalidProviderIdError,
  ProviderAlreadyRegisteredError,
  ProviderNotFoundError,
  ProviderRegistry,
} from "@agent-runtime-gateway/core";
import { describe, expect, it } from "vitest";
import { createStubProvider } from "./helpers/stub-provider.js";

describe("ProviderRegistry", () => {
  it("registers and resolves a provider by id", () => {
    const registry = new ProviderRegistry();
    const provider = createStubProvider("stub");

    registry.register(provider);

    expect(registry.resolve("stub")).toBe(provider);
    expect(registry.has("stub")).toBe(true);
    expect(registry.listIds()).toEqual(["stub"]);
  });

  it("throws when resolving an unknown provider", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.resolve("missing")).toThrow(ProviderNotFoundError);
  });

  it("throws when registering the same provider id twice", () => {
    const registry = new ProviderRegistry();
    registry.register(createStubProvider("stub"));

    expect(() => registry.register(createStubProvider("stub"))).toThrow(
      ProviderAlreadyRegisteredError,
    );
  });

  it("throws when registering a provider with a blank id", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(createStubProvider("   "))).toThrow(
      InvalidProviderIdError,
    );
  });

  it("throws when resolving a blank provider id", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.resolve("  ")).toThrow(InvalidProviderIdError);
  });

  it("treats has as false for blank provider ids", () => {
    const registry = new ProviderRegistry();

    expect(registry.has("  ")).toBe(false);
  });
});
