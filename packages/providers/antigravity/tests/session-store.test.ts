import { describe, expect, it } from "vitest";
import { AntigravitySessionStore } from "../src/session-store.js";

describe("AntigravitySessionStore", () => {
  it("expires inactive mappings lazily", () => {
    let now = 1_000;
    const store = new AntigravitySessionStore({
      ttlMs: 10,
      now: () => now,
    });
    store.set("gateway-session", "acp-session");

    now += 11;

    expect(store.get("gateway-session")).toBeUndefined();
  });

  it("evicts the least recently touched mapping at capacity", () => {
    let now = 1_000;
    const store = new AntigravitySessionStore({
      maxSessions: 2,
      ttlMs: 100,
      now: () => now,
    });
    store.set("first", "acp-first");
    now += 1;
    store.set("second", "acp-second");
    now += 1;
    expect(store.get("first")).toBe("acp-first");
    now += 1;
    store.set("third", "acp-third");

    expect(store.get("second")).toBeUndefined();
    expect(store.get("first")).toBe("acp-first");
    expect(store.get("third")).toBe("acp-third");
  });
});
