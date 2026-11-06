import { describe, expect, it } from "vitest";
import {
  createNamespacedStore,
  InMemorySessionStore,
} from "../../src/session/index.js";

describe("NamespacedSessionStore", () => {
  it("scopes operations to the specified namespace", async () => {
    const rootStore = new InMemorySessionStore<{ role: string }>();
    const cursorStore = createNamespacedStore(rootStore, "cursor");
    const antigravityStore = createNamespacedStore(rootStore, "antigravity");

    await cursorStore.set("session-1", { role: "cursor-agent" });
    await antigravityStore.set("session-1", { role: "acp-agent" });

    expect(await cursorStore.get("session-1")).toEqual({ role: "cursor-agent" });
    expect(await antigravityStore.get("session-1")).toEqual({ role: "acp-agent" });

    expect(await cursorStore.list()).toEqual(["session-1"]);
    expect(await antigravityStore.list()).toEqual(["session-1"]);

    expect(await cursorStore.exists("session-1")).toBe(true);
    await cursorStore.delete("session-1");
    expect(await cursorStore.exists("session-1")).toBe(false);
    expect(await antigravityStore.exists("session-1")).toBe(true);
  });
});
