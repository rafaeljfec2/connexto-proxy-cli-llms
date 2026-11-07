import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "@cursor/sdk";
import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import { normalizeCursorError } from "../src/errors.js";
import { cursorBackendUrl } from "../src/engine/auth-api.js";
import { CursorProvider } from "../src/provider.js";

describe("normalizeCursorError", () => {
  it("maps ConfigurationError to cursor_configuration_error", () => {
    const error = new ConfigurationError("working directory is missing");
    expect(normalizeCursorError(error)).toMatchObject({
      code: "cursor_configuration_error",
      message: "working directory is missing",
      retryable: false,
    });
  });
});

describe("cursorBackendUrl", () => {
  it("throws HttpError when CURSOR_BACKEND_BASE_URL is unset", () => {
    expect(() => cursorBackendUrl({}, "/auth/exchange_user_api_key")).toThrow(
      HttpError,
    );
    try {
      cursorBackendUrl({}, "/auth/exchange_user_api_key");
    } catch (error) {
      expect(error).toMatchObject({
        code: "cursor_missing_backend_url",
        status: 500,
      });
    }
  });
});

describe("CursorProvider throwNormalized", () => {
  it("rethrows ConfigurationError instead of cursor_unknown_error", async () => {
    const provider = new CursorProvider({ listingCredential: () => undefined });
    await expect(
      provider.execute({
        credential: { type: "cursor_api_key", value: "" },
        model: "composer-2.5",
        sessionId: "sess-empty-key",
        message: "hello",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rethrows HttpError from the in-process edge SDK path", async () => {
    const upstreamError = new HttpError(
      "Cursor SDK request failed",
      502,
      "upstream_error",
    );
    const provider = new CursorProvider({
      edgeOwnedRunner: vi.fn(() => Promise.reject(upstreamError)),
    });

    await expect(
      provider.execute({
        credential: { type: "cursor_api_key", value: "test-key" },
        model: "composer-2.5",
        sessionId: "sess-edge-error",
        message: "hello",
        cursor: { mode: "edge_owned", promptMode: "agent" },
      }),
    ).rejects.toBeInstanceOf(HttpError);

    await expect(
      provider.execute({
        credential: { type: "cursor_api_key", value: "test-key" },
        model: "composer-2.5",
        sessionId: "sess-edge-error",
        message: "hello",
        cursor: { mode: "edge_owned", promptMode: "agent" },
      }),
    ).rejects.toMatchObject({ code: "upstream_error", status: 502 });
  });
});
