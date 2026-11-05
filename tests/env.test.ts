import { loadEnv } from "@agent-runtime-gateway/api";
import { describe, expect, it } from "vitest";

describe("loadEnv", () => {
  it("applies defaults when HOST and PORT are unset", () => {
    const env = loadEnv({});
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_FORMAT).toBe("json");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.GATEWAY_API_TOKEN).toBeUndefined();
  });

  it("allows local binding without a gateway token", () => {
    expect(loadEnv({ HOST: "127.0.0.1" }).GATEWAY_API_TOKEN).toBeUndefined();
    expect(loadEnv({ HOST: "127.0.0.2" }).HOST).toBe("127.0.0.2");
    expect(loadEnv({ HOST: "::1" }).HOST).toBe("::1");
    expect(loadEnv({ HOST: "localhost" }).HOST).toBe("localhost");
  });

  it("requires a gateway token for non-loopback binding", () => {
    expect(() => loadEnv({ HOST: "0.0.0.0" })).toThrow(
      "GATEWAY_API_TOKEN is required when HOST is not loopback",
    );
    expect(() => loadEnv({ HOST: "192.168.1.10", GATEWAY_API_TOKEN: " " })).toThrow(
      "GATEWAY_API_TOKEN is required when HOST is not loopback",
    );
  });

  it("accepts a gateway token for remote binding and trims configuration whitespace", () => {
    const env = loadEnv({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: "  synthetic-token  ",
    });

    expect(env.GATEWAY_API_TOKEN).toBe("synthetic-token");
  });

  it("rejects reusing the Cursor credential as the gateway token", () => {
    expect(() =>
      loadEnv({
        HOST: "127.0.0.1",
        GATEWAY_API_TOKEN: "synthetic-shared-token",
        CURSOR_API_KEY: "synthetic-shared-token",
      }),
    ).toThrow("GATEWAY_API_TOKEN must be different from CURSOR_API_KEY");
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

  describe("CORS_ORIGINS", () => {
    it("leaves origins unset by default for the runtime local-origin policy", () => {
      expect(Reflect.get(loadEnv({}), "CORS_ORIGINS")).toBeUndefined();
    });

    it("normalizes and deduplicates a comma-separated origin list", () => {
      const env = loadEnv({
        CORS_ORIGINS:
          " HTTPS://APP.EXAMPLE.COM:443/ , http://localhost:5173, https://app.example.com ",
      });

      expect(Reflect.get(env, "CORS_ORIGINS")).toEqual([
        "https://app.example.com",
        "http://localhost:5173",
      ]);
    });

    it("allows an explicitly empty origin list", () => {
      expect(Reflect.get(loadEnv({ CORS_ORIGINS: "" }), "CORS_ORIGINS")).toEqual([]);
    });

    it.each([
      "*",
      "https://*.example.com",
      "https://app.example.com/path",
      "https://app.example.com:",
      "https://user:password@app.example.com",
      "https://app.example.com?query=value",
      "https://app.example.com,# https://other.example.com",
      "file://app.example.com",
      "https://app.example.com,,https://other.example.com",
    ])("rejects invalid origin configuration: %s", (value) => {
      expect(() => loadEnv({ CORS_ORIGINS: value })).toThrow(
        "CORS_ORIGINS must contain valid HTTP(S) origins",
      );
    });
  });
});
