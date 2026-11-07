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

  it("forwards the SDK transport version from process.env", () => {
    process.env.CURSOR_SDK_CLIENT_VERSION = "sdk-1.0.13";

    expect(defaultCursorEnv()).toMatchObject({
      CURSOR_SDK_CLIENT_VERSION: "sdk-1.0.13",
    });
  });
});
