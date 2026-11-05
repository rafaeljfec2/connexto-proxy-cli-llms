import { loadEnv } from "@agent-runtime-gateway/api";
import { describe, expect, it } from "vitest";

describe("loadEnv", () => {
  it("applies defaults when HOST and PORT are unset", () => {
    const env = loadEnv({});
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_FORMAT).toBe("json");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("accepts valid LOG_FORMAT and LOG_LEVEL", () => {
    const env = loadEnv({
      LOG_FORMAT: "pretty",
      LOG_LEVEL: "debug",
    });
    expect(env.LOG_FORMAT).toBe("pretty");
    expect(env.LOG_LEVEL).toBe("debug");
  });

  it("rejects invalid LOG_FORMAT", () => {
    expect(() => loadEnv({ LOG_FORMAT: "xml" as unknown as string })).toThrow();
  });

  it("rejects invalid LOG_LEVEL", () => {
    expect(() => loadEnv({ LOG_LEVEL: "verbose" as unknown as string })).toThrow();
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
