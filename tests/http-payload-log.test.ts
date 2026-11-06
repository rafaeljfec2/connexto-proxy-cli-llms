import { describe, expect, it } from "vitest";
import {
  parseResponseBodyForLog,
  redactSensitiveJson,
  sanitizeRequestHeaders,
  serializePayloadForLog,
} from "../apps/api/src/utils/http-payload-log.js";

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
