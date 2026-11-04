import { describe, expect, it } from "vitest";
import { resolveCursorApiKey } from "../src/credential.js";
import { mapRunResultToAgentResult, mapSdkMessageToEvents } from "../src/events.js";

describe("cursor credential", () => {
  it("accepts cursor_api_key credentials", () => {
    expect(resolveCursorApiKey({ type: "cursor_api_key", value: " test-key " })).toBe(
      "test-key",
    );
  });

  it("rejects unsupported credential types", () => {
    expect(() => resolveCursorApiKey({ type: "gateway_token", value: "x" })).toThrow(
      /Unsupported credential type/,
    );
  });
});

describe("cursor event mapping", () => {
  it("maps assistant text blocks to message.delta events", () => {
    const events = mapSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      } as never,
      "run_1",
    );

    expect(events).toEqual([{ type: "message.delta", runId: "run_1", delta: "hello" }]);
  });

  it("maps finished run results to completed agent results", () => {
    expect(
      mapRunResultToAgentResult({
        id: "run_1",
        status: "finished",
        result: "done",
      }),
    ).toEqual({
      status: "completed",
      output: { text: "done" },
    });
  });
});
