import { describe, expect, it } from "vitest";
import { cursorTestExports, streamCursorText } from "../../src/cursor.js";
import { encodeSse } from "@agent-runtime-gateway/compatibility-openai";
import { chatResponseText, connectFrame, cursorError } from "./helpers.js";

describe("Cursor stream adapter - Tool Parsing & Events", () => {
  it("parses Composer tool-call markers into structured tool calls", async () => {
    const marker = [
      "Checking the workspace.\n",
      "<|tool_calls_begin|><|tool_call_begin|>\n",
      "Glob\n",
      "<|tool_sep|>targeting\n",
      "/Users/example/project/**\n",
      "<|tool_sep|>glob_pattern\n",
      "*\n",
      "<|tool_call_end|><|tool_calls_end|>",
    ].join("");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(connectFrame(chatResponseText(marker.slice(0, 45))));
          controller.enqueue(connectFrame(chatResponseText(marker.slice(45))));
          controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "Checking the workspace.\n" },
      {
        type: "tool_call",
        toolCall: {
          name: "Glob",
          arguments: {
            targeting: "/Users/example/project/**",
            glob_pattern: "*",
          },
        },
      },
      {
        type: "done",
        finalText: "Checking the workspace.\n",
        toolCalls: [
          {
            name: "Glob",
            arguments: { targeting: "/Users/example/project/**", glob_pattern: "*" },
          },
        ],
      },
    ]);
  });

  it("parses Composer tool-call markers with direct parser", () => {
    expect(
      cursorTestExports.parseComposerToolCalls(
        "< | tool_calls_begin | >< | tool_call_begin | >\nRead< | tool_sep | >path\nREADME.md< | tool_call_end | >< | tool_calls_end | >",
      ),
    ).toEqual([{ name: "Read", arguments: { path: "README.md" } }]);
  });

  it("parses full-width Composer tool-call markers", () => {
    expect(
      cursorTestExports.parseComposerToolCalls(
        "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>\nglob\n<｜tool▁sep｜>glob_pattern\n*\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
      ),
    ).toEqual([{ name: "glob", arguments: { glob_pattern: "*" } }]);
  });

  it("parses inline Composer tool-call arguments", () => {
    expect(
      cursorTestExports.parseComposerToolCalls(
        "<|tool_calls_begin|><|tool_call_begin|>\nGlob [targeting=/Users/example/project/**, glob_pattern=*]\n<|tool_call_end|><|tool_calls_end|>",
      ),
    ).toEqual([
      {
        name: "Glob",
        arguments: { targeting: "/Users/example/project/**", glob_pattern: "*" },
      },
    ]);
  });

  it("parses JSON Composer tool-call bodies", () => {
    expect(
      cursorTestExports.parseComposerToolCalls(
        '<|tool_calls_begin|><|tool_call_begin|>{"name":"read","arguments":{"filePath":"README.md"}}<|tool_call_end|><|tool_calls_end|>',
      ),
    ).toEqual([{ name: "read", arguments: { filePath: "README.md" } }]);
  });

  it("parses alternate JSON tool-call body shapes", () => {
    expect(
      cursorTestExports.parseComposerToolCalls(
        '<|tool_calls_begin|><|tool_call_begin|>{"tool_name":"write_file","args":{"target_file":"index.html","new_contents":"hi"}}<|tool_call_end|><|tool_calls_end|>',
      ),
    ).toEqual([
      {
        name: "write_file",
        arguments: { target_file: "index.html", new_contents: "hi" },
      },
    ]);

    expect(
      cursorTestExports.parseComposerToolCalls(
        '<|tool_calls_begin|><|tool_call_begin|>{"function":{"name":"bash","arguments":"{\\"cmd\\":\\"npm test\\"}"}}<|tool_call_end|><|tool_calls_end|>',
      ),
    ).toEqual([{ name: "bash", arguments: { cmd: "npm test" } }]);
  });

  it("does not emit leading whitespace before split tool-call markers", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(connectFrame(chatResponseText("\n<｜tool")));
          controller.enqueue(
            connectFrame(
              chatResponseText(
                "▁calls▁begin｜><｜tool▁call▁begin｜>\nglob\n<｜tool▁sep｜>glob_pattern\n*\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
              ),
            ),
          );
          controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      {
        type: "tool_call",
        toolCall: { name: "glob", arguments: { glob_pattern: "*" } },
      },
      {
        type: "done",
        finalText: "",
        toolCalls: [{ name: "glob", arguments: { glob_pattern: "*" } }],
      },
    ]);
  });

  it("surfaces detailed Cursor end-stream errors", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            connectFrame(
              cursorError(
                "Too many computers.",
                "Too many computers used within the last 24 hours.",
              ),
              2,
            ),
          );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    await expect(async () => {
      for await (const _event of streamCursorText(response)) {
        void _event;
      }
    }).rejects.toThrow("Too many computers used within the last 24 hours");
  });

  it("extracts text deltas from Cursor interaction_update events", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encodeSse({ type: "text-delta", text: "Hello" }, "interaction_update"),
          );
          controller.enqueue(
            encodeSse({ type: "text-delta", text: " world" }, "interaction_update"),
          );
          controller.enqueue(
            encodeSse({ status: "FINISHED", result: "Hello world" }, "result"),
          );
          controller.close();
        },
      }),
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done", finalText: "Hello world", toolCalls: [] },
    ]);
  });

  it("falls back to legacy assistant events", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeSse({ text: "Legacy text" }, "assistant"));
          controller.enqueue(encodeSse({ status: "FINISHED" }, "result"));
          controller.close();
        },
      }),
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "Legacy text",
      toolCalls: [],
    });
  });
});
