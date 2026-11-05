import { describe, expect, it } from "vitest";
import { cursorTestExports, resolveCursorModel } from "../../src/cursor.js";
import { bytesField, fields, numberField } from "./helpers.js";

describe("cursorIdentityCache eviction", () => {
  it("evicts expired entries when evictExpiredCacheEntries is called", () => {
    const { cursorIdentityCache, evictExpiredCacheEntries } = cursorTestExports;
    const past = Date.now() - 1;
    const future = Date.now() + 3_600_000;

    cursorIdentityCache.set("expired-key", { identity: "expired", expiresAt: past });
    cursorIdentityCache.set("valid-key", { identity: "valid", expiresAt: future });

    evictExpiredCacheEntries(Date.now());

    expect(cursorIdentityCache.has("expired-key")).toBe(false);
    expect(cursorIdentityCache.has("valid-key")).toBe(true);
  });

  it("handles an empty cache without error", () => {
    const { evictExpiredCacheEntries } = cursorTestExports;
    expect(() => evictExpiredCacheEntries(Date.now())).not.toThrow();
  });
});

describe("encodeVarint guard", () => {
  it("accepts valid protobuf tags (field numbers < 2^29)", () => {
    expect(() => {
      cursorTestExports.encodeCursorChatRequest({
        prompt: { text: "hello" },
        model: "composer-2.5",
        requestId: "r1",
        conversationId: "c1",
        messageId: "m1",
      });
    }).not.toThrow();
  });
});

describe("Cursor stream adapter - Encoding & Models", () => {
  it("maps public default aliases to a concrete internal Composer model", () => {
    expect(resolveCursorModel("default")).toEqual({ id: "composer-2.5" });
    expect(resolveCursorModel("auto")).toEqual({ id: "composer-2.5" });
  });

  it("encodes attached images into the user ConversationMessage", () => {
    const body = cursorTestExports.encodeCursorChatRequest({
      prompt: { text: "Describe this image." },
      images: [
        {
          data: new Uint8Array([1, 2, 3]),
          dimension: { width: 640, height: 480 },
          uuid: "image-test",
        },
      ],
      model: "composer-2.5",
      requestId: "request-test",
      conversationId: "conversation-test",
      messageId: "message-test",
    });

    const outer = fields(body);
    const request = fields(bytesField(outer, 1));
    const userMessage = fields(bytesField(request, 1));
    const image = fields(bytesField(userMessage, 10));
    const dimension = fields(bytesField(image, 2));

    expect(bytesField(userMessage, 1)).toEqual(
      new TextEncoder().encode("Describe this image."),
    );
    expect(bytesField(image, 1)).toEqual(new Uint8Array([1, 2, 3]));
    expect(numberField(dimension, 1)).toBe(640);
    expect(numberField(dimension, 2)).toBe(480);
    expect(bytesField(image, 3)).toEqual(new TextEncoder().encode("image-test"));
  });

  it("encodes Agent mode for tool-capable requests", () => {
    const body = cursorTestExports.encodeCursorChatRequest({
      prompt: { text: "List files.", mode: "agent" },
      model: "composer-2.5",
      requestId: "request-test",
      conversationId: "conversation-test",
      messageId: "message-test",
    });

    const outer = fields(body);
    const request = fields(bytesField(outer, 1));

    expect(new TextDecoder().decode(bytesField(request, 54))).toBe("Agent");
  });

  it("defaults to Ask mode for plain chat requests", () => {
    const body = cursorTestExports.encodeCursorChatRequest({
      prompt: { text: "Say hello." },
      model: "composer-2.5",
      requestId: "request-test",
      conversationId: "conversation-test",
      messageId: "message-test",
    });

    const outer = fields(body);
    const request = fields(bytesField(outer, 1));

    expect(new TextDecoder().decode(bytesField(request, 54))).toBe("Ask");
  });
});
