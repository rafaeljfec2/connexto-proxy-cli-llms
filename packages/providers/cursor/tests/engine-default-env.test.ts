import { afterEach, describe, expect, it } from "vitest";
import { defaultCursorEnv } from "../src/engine/types.js";

describe("defaultCursorEnv", () => {
  const previous = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });

  it("forwards SDK bridge variables from process.env", () => {
    process.env.CURSOR_SDK_BRIDGE_URL = "http://127.0.0.1:8792/sdk";
    process.env.CURSOR_SDK_BRIDGE_TIMEOUT_MS = "120000";
    process.env.CURSOR_SDK_CLIENT_VERSION = "sdk-1.0.13";

    expect(defaultCursorEnv()).toMatchObject({
      CURSOR_SDK_BRIDGE_URL: "http://127.0.0.1:8792/sdk",
      CURSOR_SDK_BRIDGE_TIMEOUT_MS: "120000",
      CURSOR_SDK_CLIENT_VERSION: "sdk-1.0.13",
    });
  });
});
