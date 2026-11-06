import { describe, expect, it } from "vitest";
import { SessionUpdateAccumulator } from "@agent-runtime-gateway/provider-antigravity/acp";
import type { SessionUpdateParams } from "@agent-runtime-gateway/provider-antigravity/acp";

function chunkUpdate(
  kind: "agent_message_chunk" | "agent_thought_chunk",
  text: string,
): SessionUpdateParams {
  return {
    sessionId: "sess-x",
    update: { sessionUpdate: kind, content: { type: "text", text } },
  };
}

describe("ACP session update accumulator", () => {
  it("reconstructs agent text from streamed agent_message_chunk updates", () => {
    const accumulator = new SessionUpdateAccumulator();

    accumulator.handle({
      sessionId: "sess-x",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "POC-" },
      },
    });
    accumulator.handle({
      sessionId: "sess-x",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ACP-OK" },
      },
    });

    expect(accumulator.getAgentText()).toBe("POC-ACP-OK");
    expect(accumulator.getThoughtText()).toBe("");
  });

  it("keeps reasoning text separate from the agent message", () => {
    const accumulator = new SessionUpdateAccumulator();

    accumulator.handle(chunkUpdate("agent_thought_chunk", "plan first"));
    accumulator.handle(chunkUpdate("agent_message_chunk", "message"));

    expect(accumulator.getThoughtText()).toBe("plan first");
    expect(accumulator.getAgentText()).toBe("message");
  });

  it("forwards every update kind to the consumer including non-chunks", () => {
    const seen: string[] = [];
    const accumulator = new SessionUpdateAccumulator((sessionId, kind) => {
      seen.push(`${sessionId}:${kind}`);
    });

    accumulator.handle({
      sessionId: "sess-x",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "tool",
        kind: "other",
        status: "pending",
      },
    });
    accumulator.handle(chunkUpdate("agent_message_chunk", "hi"));

    expect(seen).toEqual(["sess-x:tool_call", "sess-x:agent_message_chunk"]);
  });

  it("ignores malformed update payloads", () => {
    const accumulator = new SessionUpdateAccumulator();

    accumulator.handle({
      sessionId: "sess-x",
      update: "not-an-object",
    } as unknown as SessionUpdateParams);

    expect(accumulator.getAgentText()).toBe("");
  });
});
