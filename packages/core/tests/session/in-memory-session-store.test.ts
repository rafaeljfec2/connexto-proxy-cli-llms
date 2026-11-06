import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../../src/session/index.js";

describe("InMemorySessionStore", () => {
  it("stores, retrieves, and checks existence of values", async () => {
    const store = new InMemorySessionStore<{ id: string; count: number }>();

    expect(await store.get("test-ns", "key-1")).toBeUndefined();
    expect(await store.exists("test-ns", "key-1")).toBe(false);

    await store.set("test-ns", "key-1", { id: "a", count: 10 });

    expect(await store.exists("test-ns", "key-1")).toBe(true);
    const retrieved = await store.get("test-ns", "key-1");
    expect(retrieved).toEqual({ id: "a", count: 10 });
  });

  it("deletes values and confirms non-existence", async () => {
    const store = new InMemorySessionStore<string>();

    await store.set("ns1", "k1", "value-1");
    expect(await store.delete("ns1", "k1")).toBe(true);
    expect(await store.delete("ns1", "k1")).toBe(false);
    expect(await store.exists("ns1", "k1")).toBe(false);
    expect(await store.get("ns1", "k1")).toBeUndefined();
  });

  it("isolates namespaces", async () => {
    const store = new InMemorySessionStore<string>();

    await store.set("ns-a", "shared-key", "value-a");
    await store.set("ns-b", "shared-key", "value-b");

    expect(await store.get("ns-a", "shared-key")).toBe("value-a");
    expect(await store.get("ns-b", "shared-key")).toBe("value-b");

    expect(await store.list("ns-a")).toEqual(["shared-key"]);
    expect(await store.list("ns-b")).toEqual(["shared-key"]);

    await store.clear("ns-a");
    expect(await store.get("ns-a", "shared-key")).toBeUndefined();
    expect(await store.get("ns-b", "shared-key")).toBe("value-b");
  });
});
