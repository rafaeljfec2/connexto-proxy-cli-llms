import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FilesystemSessionStore,
  InvalidSessionKeyError,
  SessionStorageError,
} from "../../src/session/index.js";

describe("FilesystemSessionStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "connexto-session-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates directories automatically and stores and retrieves data", async () => {
    const store = new FilesystemSessionStore<{ username: string; token: string }>({
      rootDir: path.join(tempDir, "nested", "sessions"),
    });

    expect(await store.get("auth", "session-1")).toBeUndefined();
    expect(await store.exists("auth", "session-1")).toBe(false);

    await store.set("auth", "session-1", {
      username: "alice",
      token: "secret-abc",
    });

    expect(await store.exists("auth", "session-1")).toBe(true);
    const retrieved = await store.get("auth", "session-1");
    expect(retrieved).toEqual({
      username: "alice",
      token: "secret-abc",
    });
  });

  it("persists data across separate store instances pointing to the same directory", async () => {
    const storagePath = path.join(tempDir, "persisted-sessions");

    const instance1 = new FilesystemSessionStore<{ agentId: string; ts: number }>({
      rootDir: storagePath,
    });
    await instance1.set("cursor", "sess-100", { agentId: "agent-xyz", ts: 123456 });

    const instance2 = new FilesystemSessionStore<{ agentId: string; ts: number }>({
      rootDir: storagePath,
    });
    const retrieved = await instance2.get("cursor", "sess-100");
    expect(retrieved).toEqual({ agentId: "agent-xyz", ts: 123456 });
  });

  it("deletes entries and returns false when deleting non-existent entries", async () => {
    const store = new FilesystemSessionStore<string>({ rootDir: tempDir });

    await store.set("provider", "item-1", "test-val");
    expect(await store.delete("provider", "item-1")).toBe(true);
    expect(await store.delete("provider", "item-1")).toBe(false);
    expect(await store.get("provider", "item-1")).toBeUndefined();
  });

  it("strictly isolates namespaces", async () => {
    const store = new FilesystemSessionStore<string>({ rootDir: tempDir });

    await store.set("cursor", "session-alpha", "cursor-payload");
    await store.set("antigravity", "session-alpha", "antigravity-payload");

    expect(await store.get("cursor", "session-alpha")).toBe("cursor-payload");
    expect(await store.get("antigravity", "session-alpha")).toBe("antigravity-payload");

    const cursorList = await store.list("cursor");
    const antigravityList = await store.list("antigravity");
    expect(cursorList).toEqual(["session-alpha"]);
    expect(antigravityList).toEqual(["session-alpha"]);

    await store.clear("cursor");
    expect(await store.get("cursor", "session-alpha")).toBeUndefined();
    expect(await store.get("antigravity", "session-alpha")).toBe("antigravity-payload");
  });

  it("performs atomic writes without leaving orphaned temp files", async () => {
    const store = new FilesystemSessionStore<object>({ rootDir: tempDir });

    await store.set("ns", "key1", { a: 1 });
    await store.set("ns", "key2", { b: 2 });

    const nsDir = path.join(tempDir, "ns");
    const files = await fs.readdir(nsDir);
    expect(files.sort()).toEqual(["key1.json", "key2.json"]);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("protects against path traversal in namespace and key", async () => {
    const store = new FilesystemSessionStore<string>({ rootDir: tempDir });

    await expect(store.get("../etc", "passwd")).rejects.toThrow(InvalidSessionKeyError);
    await expect(store.set("ns", "../escape", "val")).rejects.toThrow(
      InvalidSessionKeyError,
    );
    await expect(store.delete("../../", "key")).rejects.toThrow(InvalidSessionKeyError);
  });

  it("handles concurrent writes consistently", async () => {
    const store = new FilesystemSessionStore<{ seq: number }>({ rootDir: tempDir });

    const totalWrites = 25;
    const promises = Array.from({ length: totalWrites }, (_, i) =>
      store.set("concurrent-ns", `key-${i}`, { seq: i }),
    );

    await Promise.all(promises);

    const keys = await store.list("concurrent-ns");
    expect(keys.length).toBe(totalWrites);

    for (let i = 0; i < totalWrites; i++) {
      const item = await store.get("concurrent-ns", `key-${i}`);
      expect(item).toEqual({ seq: i });
    }
  });

  it("fails fast if rootDir is empty", () => {
    expect(() => new FilesystemSessionStore({ rootDir: "" })).toThrow(
      SessionStorageError,
    );
  });
});
