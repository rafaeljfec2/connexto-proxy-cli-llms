import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "@agent-runtime-gateway/core";
import {
  AntigravitySessionStore,
  type AcpSessionRecord,
} from "../src/session-store.js";

describe("AntigravitySessionStore Persistence", () => {
  it("persists sessions to the store and resolves them across instances", async () => {
    const store = new InMemorySessionStore<AcpSessionRecord>();

    const instance1 = new AntigravitySessionStore({ store });
    await instance1.setPersisted("gateway-sess-1", "acp-sess-999");

    // Check directly in the store under "antigravity" namespace
    const recordInStore = await store.get("antigravity", "gateway-sess-1");
    expect(recordInStore).toBeDefined();
    expect(recordInStore?.acpSessionId).toBe("acp-sess-999");

    // Simulate restart with instance2 pointing to the same store
    const instance2 = new AntigravitySessionStore({ store });
    // In-memory cache is initially empty
    expect(instance2.get("gateway-sess-1")).toBeUndefined();

    // resolve() pulls from the store and populates in-memory cache
    const resolvedId = await instance2.resolve("gateway-sess-1");
    expect(resolvedId).toBe("acp-sess-999");
    expect(instance2.get("gateway-sess-1")).toBe("acp-sess-999");
  });

  it("removes session from store on delete", async () => {
    const store = new InMemorySessionStore<AcpSessionRecord>();
    const sessionStore = new AntigravitySessionStore({ store });

    await sessionStore.setPersisted("sess-to-del", "acp-del");
    expect(await store.exists("antigravity", "sess-to-del")).toBe(true);

    const deleted = await sessionStore.delete("sess-to-del");
    expect(deleted).toBe(true);
    expect(await store.exists("antigravity", "sess-to-del")).toBe(false);
  });

  it("listAllAcpSessionIds dedupes memory and persisted records", async () => {
    const store = new InMemorySessionStore<AcpSessionRecord>();
    const sessionStore = new AntigravitySessionStore({ store });

    await sessionStore.setPersisted("gw-a", "acp-shared");
    await sessionStore.setPersisted("gw-b", "acp-shared");
    await sessionStore.setPersisted("gw-c", "acp-other");

    const ids = (await sessionStore.listAllAcpSessionIds()).sort();
    expect(ids).toEqual(["acp-other", "acp-shared"]);
  });

  it("clearInMemory drops cached mappings without touching the backing store", async () => {
    const store = new InMemorySessionStore<AcpSessionRecord>();
    const sessionStore = new AntigravitySessionStore({ store });

    await sessionStore.setPersisted("gw-1", "acp-1");
    expect(sessionStore.get("gw-1")).toBe("acp-1");

    sessionStore.clearInMemory();
    expect(sessionStore.get("gw-1")).toBeUndefined();
    expect(await store.get("antigravity", "gw-1")).toBeDefined();
  });

  it("expires persisted session when TTL passes", async () => {
    const store = new InMemorySessionStore<AcpSessionRecord>();
    let now = 10_000;
    const sessionStore = new AntigravitySessionStore({
      store,
      ttlMs: 50,
      now: () => now,
    });

    await sessionStore.setPersisted("exp-sess", "acp-exp");
    expect(await sessionStore.resolve("exp-sess")).toBe("acp-exp");

    now += 60;
    expect(await sessionStore.resolve("exp-sess")).toBeUndefined();
    expect(await store.exists("antigravity", "exp-sess")).toBe(false);
  });
});
