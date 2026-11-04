import { loadEnv } from "@agent-runtime-gateway/api";
import { describe, expect, it } from "vitest";

describe("loadEnv", () => {
  it("applies defaults when HOST and PORT are unset", () => {
    const env = loadEnv({});
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3000);
  });

  it("rejects empty HOST", () => {
    expect(() => loadEnv({ HOST: "" })).toThrow();
    expect(() => loadEnv({ HOST: "   " })).toThrow();
  });

  it("rejects invalid PORT", () => {
    expect(() => loadEnv({ PORT: "abc" })).toThrow();
    expect(() => loadEnv({ PORT: "0" })).toThrow();
  });
});
