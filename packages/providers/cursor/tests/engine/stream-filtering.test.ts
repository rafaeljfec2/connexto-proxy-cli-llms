import { describe, expect, it } from "vitest";
import { streamCursorText } from "../../src/cursor.js";
import { chatResponseText, chatResponseThinking, connectFrame } from "./helpers.js";

describe("Cursor stream adapter - Stream Filtering", () => {
  it("extracts final text from raw Cursor Connect/protobuf frames", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(connectFrame(chatResponseText("Hello")));
          controller.enqueue(connectFrame(chatResponseText(" from Composer")));
          controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " from Composer" },
      { type: "done", finalText: "Hello from Composer", toolCalls: [] },
    ]);
  });

  it("strips Composer thinking before yielding final Cursor text", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            connectFrame(chatResponseThinking("The user asked for OK.")),
          );
          controller.enqueue(connectFrame(chatResponseThinking("\n</think>\nOK")));
          controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "OK" },
      { type: "done", finalText: "OK", toolCalls: [] },
    ]);
  });

  it("strips Composer final markers when there is no think closing tag", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            connectFrame(
              chatResponseThinking("Hidden reasoning <｜final｜>Visible answer"),
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
      { type: "text", text: "Visible answer" },
      { type: "done", finalText: "Visible answer", toolCalls: [] },
    ]);
  });

  it("strips Composer final markers from normal text frames", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            connectFrame(
              chatResponseText("Hidden reasoning <｜final｜>\nVisible answer"),
            ),
          );
          controller.enqueue(
            connectFrame(chatResponseText("< | final | >Second answer")),
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
      { type: "text", text: "Visible answer" },
      { type: "text", text: "Second answer" },
      { type: "done", finalText: "Visible answerSecond answer", toolCalls: [] },
    ]);
  });

  it("strips Composer final markers split across normal text frames", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(connectFrame(chatResponseText("<")));
          controller.enqueue(connectFrame(chatResponseText("｜fina")));
          controller.enqueue(connectFrame(chatResponseText("l｜")));
          controller.enqueue(connectFrame(chatResponseText(">\n\nVisible answer")));
          controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/connect+proto" } },
    );
    const events = [];
    for await (const event of streamCursorText(response)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "Visible answer" },
      { type: "done", finalText: "Visible answer", toolCalls: [] },
    ]);
  });
});
