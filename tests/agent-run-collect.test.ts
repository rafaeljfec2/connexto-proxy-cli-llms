import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentResult, AgentRun } from "@agent-runtime-gateway/core";
import {
  drainAgentRunEvents,
  openAiToolCallFromAgentEvent,
} from "../apps/api/src/utils/agent-run-collect.js";
import { collectRunOutput, confirmStreamingRunSuccess } from "../apps/api/src/utils/run.js";

function stubRun(events: AgentEvent[], result: AgentResult): AgentRun {
  function* gen() {
    for (const event of events) {
      yield event;
    }
  }
  return {
    id: "run_test",
    events: gen(),
    wait: () => Promise.resolve(result),
    cancel: () => Promise.resolve(),
  };
}

const toolEvents: AgentEvent[] = [
  { type: "message.delta", runId: "r", delta: "hi" },
  {
    type: "tool.call",
    runId: "r",
    toolName: "list_dir",
    callId: "call_1",
    arguments: "{\"path\":\".\"}",
  },
  { type: "run.completed", runId: "r" },
];

describe("agent-run-collect", () => {
  it("maps tool.call events to OpenAI tool calls", async () => {
    const run = stubRun(toolEvents, { status: "completed", output: { text: "hi" } });

    const output = await drainAgentRunEvents(run);
    expect(output.text).toBe("hi");
    expect(output.toolCalls).toHaveLength(1);
    expect(openAiToolCallFromAgentEvent({
      type: "tool.call",
      runId: "r",
      toolName: "list_dir",
      callId: "call_1",
      arguments: "{\"path\":\".\"}",
    })).toEqual(output.toolCalls[0]);
  });

  it("collectRunOutput returns tool calls", async () => {
    const run = stubRun(toolEvents, { status: "completed", output: { text: "hi" } });
    const collected = await collectRunOutput(run);
    expect(collected?.toolCalls).toHaveLength(1);
  });

  it("confirmStreamingRunSuccess fails when wait returns failed", async () => {
    const run = stubRun([], { status: "failed", error: { message: "x" } });
    const ok = await confirmStreamingRunSuccess(run, "cursor", {
      headersSent: false,
      locals: { requestId: "test-req" },
      status: () => ({ json: () => undefined }),
      write: () => true,
      end: () => undefined,
    } as never);
    expect(ok).toBe(false);
  });
});
