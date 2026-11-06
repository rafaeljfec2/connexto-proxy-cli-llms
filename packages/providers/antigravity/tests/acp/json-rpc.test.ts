import { describe, expect, it } from "vitest";
import {
  MessageStreamDecoder,
  buildNotification,
  buildRequest,
  serializeMessage,
} from "@agent-runtime-gateway/provider-antigravity/acp";

describe("ACP JSON-RPC NDJSON framing", () => {
  it("encodes requests and notifications as single-line JSON", () => {
    const request = buildRequest(7, "initialize", { protocolVersion: 1 });
    const notification = buildNotification("session/cancel", { sessionId: "s" });

    expect(serializeMessage(request)).toContain('"id":7');
    expect(serializeMessage(request).endsWith("\n")).toBe(true);
    expect(serializeMessage(request).split("\n")).toHaveLength(2);
    expect(JSON.parse(serializeMessage(notification))).toMatchObject({
      method: "session/cancel",
      params: { sessionId: "s" },
    });
    expect(JSON.parse(serializeMessage(notification))["id"]).toBeUndefined();
  });

  it("decodes messages incrementally across split chunks", () => {
    const decoder = new MessageStreamDecoder();
    const first = serializeMessage({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    const second = serializeMessage({ jsonrpc: "2.0", id: 2, result: { b: 2 } });
    const partial = first.slice(0, first.length / 2);
    const rest = first.slice(first.length / 2);

    expect(decoder.push(partial)).toHaveLength(0);
    expect(decoder.push(rest + second)).toHaveLength(2);
    expect(decoder.flush()).toHaveLength(0);
  });

  it("defers non-JSON stdout lines instead of parsing them as protocol", () => {
    const invalidLines: string[] = [];
    const decoder = new MessageStreamDecoder((line) => invalidLines.push(line));

    const messages = decoder.push(
      'garbage-not-json\n{"jsonrpc":"2.0","id":3,"result":{}}\n',
    );

    expect(messages).toHaveLength(1);
    expect(invalidLines).toEqual(["garbage-not-json"]);
  });

  it("ignores empty lines and trailing partial data without errors", () => {
    const decoder = new MessageStreamDecoder();

    expect(decoder.push("\n\n  \n")).toHaveLength(0);
    expect(decoder.push('{"jsonrpc":"2.0"')).toHaveLength(0);
    expect(decoder.push(',"id":9,"result":{}}\n')).toHaveLength(1);
  });

  it("rejects JSON payloads that are not JSON-RPC shaped", () => {
    const invalid: string[] = [];
    const decoder = new MessageStreamDecoder((line) => invalid.push(line));

    const messages = decoder.push('{"jsonrpc":"1.0","id":1}\n[1,2,3]\n42\n');

    expect(messages).toHaveLength(0);
    expect(invalid).toEqual(['{"jsonrpc":"1.0","id":1}', "[1,2,3]", "42"]);
  });
});
