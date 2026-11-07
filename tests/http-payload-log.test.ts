import { describe, expect, it } from "vitest";
import {
  parseResponseBodyForLog,
  redactSensitiveJson,
  sanitizeRequestHeaders,
  serializePayloadForLog,
} from "../apps/api/src/utils/http-payload-log.js";

describe("http payload logging helpers — image payloads", () => {
  const base64Png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("never logs a data URL image", () => {
    const logged = JSON.stringify(
      serializePayloadForLog(
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${base64Png}` },
                },
              ],
            },
          ],
        },
        262_144,
      ),
    );

    expect(logged).not.toContain(base64Png);
    expect(logged).toContain("[REDACTED:image-data]");
    expect(logged).toContain("describe");
  });

  it("never logs the base64 data of an image part", () => {
    const logged = JSON.stringify(
      serializePayloadForLog(
        { type: "image", mimeType: "image/png", data: base64Png },
        262_144,
      ),
    );

    expect(logged).not.toContain(base64Png);
  });

  it("keeps only the origin and path of an image URL", () => {
    const logged = JSON.stringify(
      serializePayloadForLog(
        {
          content: [
            {
              type: "input_image",
              image_url: "https://images.example.com/a.png?X-Amz-Signature=abc123",
            },
          ],
        },
        262_144,
      ),
    );

    expect(logged).toContain("https://images.example.com/a.png");
    expect(logged).not.toContain("X-Amz-Signature");
    expect(logged).not.toContain("abc123");
  });

  it("redacts base64 nested under an image source with media_type", () => {
    const logged = JSON.stringify(
      serializePayloadForLog(
        {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64Png },
            },
          ],
        },
        262_144,
      ),
    );

    expect(logged).not.toContain(base64Png);
  });

  it("redacts data URLs with a bare image MIME type and whitespace before ';'", () => {
    const bare = JSON.stringify(
      serializePayloadForLog({ url: `data:image;base64,${base64Png}` }, 262_144),
    );
    const spaced = JSON.stringify(
      serializePayloadForLog({ url: `data:image/png ;base64,${base64Png}` }, 262_144),
    );

    expect(bare).not.toContain(base64Png);
    expect(spaced).not.toContain(base64Png);
  });

  it("redacts long base64 runs inside an image context", () => {
    const longRun = "A".repeat(300);
    const logged = JSON.stringify(
      serializePayloadForLog({ type: "image", payload: longRun }, 262_144),
    );

    expect(logged).not.toContain(longRun);
  });

  it("redacts a data URL echoed in a non-JSON text response", () => {
    const parsed = parseResponseBodyForLog(
      `data:image/png;base64,${base64Png}`,
      "text/plain",
      262_144,
    );

    expect(JSON.stringify(parsed)).not.toContain(base64Png);
  });

  it("does not alter ordinary text that merely starts with 'data:'", () => {
    expect(
      serializePayloadForLog(
        { input: "data: not an image", model: "antigravity:x" },
        262_144,
      ),
    ).toEqual({ input: "data: not an image", model: "antigravity:x" });
  });
});

describe("http payload logging helpers", () => {
  it("redacts sensitive headers and JSON credential fields", () => {
    expect(
      sanitizeRequestHeaders({
        authorization: "Bearer secret-key",
        "content-type": "application/json",
        "x-api-key": "cursor-key",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      "content-type": "application/json",
      "x-api-key": "[REDACTED]",
    });

    expect(
      redactSensitiveJson({
        model: "composer-2.5",
        api_key: "hidden",
        nested: { access_token: "tok" },
      }),
    ).toEqual({
      model: "composer-2.5",
      api_key: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    });
  });

  it("truncates oversized serialized payloads", () => {
    const large = { text: "x".repeat(500) };
    const logged = serializePayloadForLog(large, 64);
    expect(logged).toMatchObject({
      __truncated: true,
      byteLength: expect.any(Number),
      preview: expect.any(String),
    });
  });

  it("parses SSE response bodies into event arrays", () => {
    const sse = 'data: {"id":"1","choices":[]}\n\n' + "data: [DONE]\n\n";
    const parsed = parseResponseBodyForLog(sse, "text/event-stream", 32_768);
    expect(parsed).toEqual([{ id: "1", choices: [] }, "[DONE]"]);
  });
});
