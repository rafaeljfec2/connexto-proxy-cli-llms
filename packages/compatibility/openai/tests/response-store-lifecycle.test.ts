import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ResponseSessionStore, type StoredResponse } from "../src/response-store.js";

function completed(
  id: string,
  overrides: Partial<StoredResponse> = {},
): StoredResponse {
  return {
    id,
    created: Math.floor(Date.now() / 1000),
    model: "composer-2.5",
    inputItems: [],
    ownerPrincipal: "principal-a",
    responseData: { id, object: "response" },
    ...overrides,
  };
}

describe("ResponseSessionStore lifecycle", () => {
  let store: ResponseSessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    store = new ResponseSessionStore({ maxEntries: 3, ttlMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires completed responses after TTL", () => {
    store.set("resp_1", completed("resp_1"));
    vi.advanceTimersByTime(59_999);
    store.cleanup();
    expect(store.has("resp_1")).toBe(true);
    vi.advanceTimersByTime(2);
    store.cleanup();
    expect(store.has("resp_1")).toBe(false);
    expect(store.stats().removedByTtl).toBe(1);
  });

  it("does not expire active pinned responses", () => {
    store.set("resp_active", completed("resp_active"));
    store.pinActive("resp_active");
    vi.advanceTimersByTime(120_000);
    store.cleanup();
    expect(store.has("resp_active")).toBe(true);
    store.unpinActive("resp_active");
    store.cleanup();
    expect(store.has("resp_active")).toBe(false);
  });

  it("expires cancelled and failed terminal records", () => {
    store.recordTerminal("resp_cancelled", completed("resp_cancelled"), "cancelled");
    store.recordTerminal("resp_failed", completed("resp_failed"), "failed");
    vi.advanceTimersByTime(120_000);
    store.cleanup();
    expect(store.has("resp_cancelled")).toBe(false);
    expect(store.has("resp_failed")).toBe(false);
  });

  it("enforces max entries by removing oldest eligible records first", () => {
    store.set("resp_1", completed("resp_1"));
    store.set("resp_2", completed("resp_2"));
    store.set("resp_3", completed("resp_3"));
    store.set("resp_4", completed("resp_4"));
    expect(store.has("resp_1")).toBe(false);
    expect(store.has("resp_4")).toBe(true);
    expect(store.stats().removedByLimit).toBeGreaterThanOrEqual(1);
  });

  it("never evicts active responses when enforcing the limit", () => {
    store.set("resp_1", completed("resp_1"));
    store.set("resp_2", completed("resp_2"));
    store.pinActive("resp_1");
    store.set("resp_3", completed("resp_3"));
    store.set("resp_4", completed("resp_4"));
    expect(store.has("resp_1")).toBe(true);
    store.unpinActive("resp_1");
  });

  it("removes associated tool call memory when a response is evicted", () => {
    store.set("resp_1", completed("resp_1"));
    store.storeToolCalls("resp_1", [{ type: "tool" }]);
    vi.advanceTimersByTime(120_000);
    store.cleanup();
    expect(store.getToolCalls("resp_1")).toBeUndefined();
  });

  it("preserves ownerPrincipal on stored entries", () => {
    store.set("resp_owned", completed("resp_owned", { ownerPrincipal: "user-42" }));
    expect(store.get("resp_owned")?.ownerPrincipal).toBe("user-42");
  });
});
