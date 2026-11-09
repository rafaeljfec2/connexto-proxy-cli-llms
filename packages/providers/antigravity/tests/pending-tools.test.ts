import { describe, expect, it } from "vitest";
import {
  PendingToolRegistry,
  PendingToolRegistryError,
} from "../src/pending-tools.js";

describe("PendingToolRegistry", () => {
  it("registers and retrieves a pending tool call", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_abc123",
      toolName: "get_external_test_context",
      arguments: { query: "test_key" },
      sessionId: "session_1",
    });

    const call = registry.get("call_abc123");
    expect(call).toBeDefined();
    expect(call?.toolName).toBe("get_external_test_context");
    expect(call?.arguments).toEqual({ query: "test_key" });
    expect(call?.sessionId).toBe("session_1");
    expect(call?.consumed).toBe(false);
  });

  it("validates and marks a tool call as consumed", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_abc123",
      toolName: "get_external_test_context",
      arguments: { query: "test_key" },
      sessionId: "session_1",
    });

    const consumed = registry.validateAndConsume(
      "call_abc123",
      "session_1",
      "get_external_test_context",
    );
    expect(consumed.callId).toBe("call_abc123");
    expect(consumed.consumed).toBe(true);
  });

  it("rejects result when pending tool call does not exist", () => {
    const registry = new PendingToolRegistry();
    expect(() =>
      registry.validateAndConsume("call_non_existent", "session_1"),
    ).toThrowError(PendingToolRegistryError);

    try {
      registry.validateAndConsume("call_non_existent", "session_1");
    } catch (err: any) {
      expect(err.code).toBe("pending_call_not_found");
    }
  });

  it("enforces session ownership and rejects mismatched session", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_abc123",
      toolName: "get_external_test_context",
      arguments: {},
      sessionId: "session_owner",
    });

    try {
      registry.validateAndConsume("call_abc123", "different_session");
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe("session_mismatch");
      expect(err.message).toContain("belongs to session 'session_owner'");
    }
  });

  it("rejects duplicate submissions (replay protection)", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_abc123",
      toolName: "get_external_test_context",
      arguments: {},
      sessionId: "session_1",
    });

    // First consumption succeeds
    registry.validateAndConsume("call_abc123", "session_1");

    // Second consumption must fail
    try {
      registry.validateAndConsume("call_abc123", "session_1");
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe("call_already_consumed");
      expect(err.message).toContain("already been consumed");
    }
  });

  it("rejects result when tool name does not match the registered call", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_abc123",
      toolName: "get_external_test_context",
      arguments: {},
      sessionId: "session_1",
    });

    try {
      registry.validateAndConsume("call_abc123", "session_1", "different_tool");
      expect.unreachable();
    } catch (err: any) {
      expect(err.code).toBe("tool_name_mismatch");
      expect(err.message).toContain("registered for tool 'get_external_test_context'");
    }
  });

  it("expires stale pending calls after TTL", () => {
    let fakeNow = 1_000_000;
    const registry = new PendingToolRegistry({
      ttlMs: 5_000,
      now: () => fakeNow,
    });

    registry.register({
      callId: "call_1",
      toolName: "test_tool",
      arguments: {},
      sessionId: "sess_1",
    });

    expect(registry.get("call_1")).toBeDefined();

    // Advance time past TTL
    fakeNow += 6_000;

    expect(registry.get("call_1")).toBeUndefined();
    expect(() =>
      registry.validateAndConsume("call_1", "sess_1"),
    ).toThrowError(PendingToolRegistryError);
  });

  it("lists pending calls per session and clears all calls", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_1",
      toolName: "tool_1",
      arguments: {},
      sessionId: "sess_A",
    });
    registry.register({
      callId: "call_2",
      toolName: "tool_2",
      arguments: {},
      sessionId: "sess_A",
    });
    registry.register({
      callId: "call_3",
      toolName: "tool_3",
      arguments: {},
      sessionId: "sess_B",
    });

    expect(registry.listPending("sess_A")).toHaveLength(2);
    expect(registry.listPending("sess_B")).toHaveLength(1);

    registry.clear();
    expect(registry.listPending("sess_A")).toHaveLength(0);
    expect(registry.listPending("sess_B")).toHaveLength(0);
  });

  it("handles multiple concurrent tool calls within the same session", () => {
    const registry = new PendingToolRegistry();
    registry.register({
      callId: "call_batch_1",
      toolName: "get_weather",
      arguments: { location: "São Paulo" },
      sessionId: "session_multi",
    });
    registry.register({
      callId: "call_batch_2",
      toolName: "get_time",
      arguments: { timezone: "America/Sao_Paulo" },
      sessionId: "session_multi",
    });

    expect(registry.listPending("session_multi")).toHaveLength(2);

    const c1 = registry.validateAndConsume("call_batch_1", "session_multi", "get_weather");
    expect(c1.consumed).toBe(true);

    const c2 = registry.validateAndConsume("call_batch_2", "session_multi", "get_time");
    expect(c2.consumed).toBe(true);

    expect(registry.listPending("session_multi")).toHaveLength(0);
  });

  it("handles multiple sequential cycles across different turns in the same session", () => {
    const registry = new PendingToolRegistry();
    // Turn 1
    registry.register({
      callId: "call_turn_1",
      toolName: "step_one_tool",
      arguments: { step: 1 },
      sessionId: "session_cycle",
    });
    expect(registry.listPending("session_cycle")).toHaveLength(1);
    registry.validateAndConsume("call_turn_1", "session_cycle", "step_one_tool");
    expect(registry.listPending("session_cycle")).toHaveLength(0);

    // Turn 2
    registry.register({
      callId: "call_turn_2",
      toolName: "step_two_tool",
      arguments: { step: 2 },
      sessionId: "session_cycle",
    });
    expect(registry.listPending("session_cycle")).toHaveLength(1);
    registry.validateAndConsume("call_turn_2", "session_cycle", "step_two_tool");
    expect(registry.listPending("session_cycle")).toHaveLength(0);
  });
});

