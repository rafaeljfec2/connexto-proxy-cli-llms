import { describe, it, expect } from "vitest";
import { validateTargetUrl, InvalidTargetUrlError } from "../src/target-validator.js";

describe("validateTargetUrl (SSRF Guard)", () => {
  it("allows valid public HTTPS URLs", () => {
    const result = validateTargetUrl("https://cursor.com/login");
    expect(result.valid).toBe(true);
    expect(result.parsedUrl.hostname).toBe("cursor.com");
  });

  it("allows valid public HTTP URLs", () => {
    const result = validateTargetUrl("http://example.com/auth");
    expect(result.valid).toBe(true);
  });

  it("rejects file, gopher, and unsupported protocols", () => {
    expect(() => validateTargetUrl("file:///etc/passwd")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("javascript:alert(1)")).toThrow(InvalidTargetUrlError);
  });

  it("blocks localhost and loopback IPv4/IPv6", () => {
    expect(() => validateTargetUrl("http://localhost:8080")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://127.0.0.1:9222")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://127.0.0.2:8000")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://[::1]:9222")).toThrow(InvalidTargetUrlError);
  });

  it("blocks cloud metadata service endpoints", () => {
    expect(() => validateTargetUrl("http://169.254.169.254/latest/meta-data/")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://metadata.google.internal/computeMetadata/v1/")).toThrow(InvalidTargetUrlError);
  });

  it("blocks RFC 1918 private IPv4 networks", () => {
    expect(() => validateTargetUrl("http://10.0.0.1:8080/")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://172.16.0.1:8080/")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://172.31.255.255:8080/")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://192.168.1.1:8080/")).toThrow(InvalidTargetUrlError);
    expect(() => validateTargetUrl("http://192.168.100.64:4318/")).toThrow(InvalidTargetUrlError);
  });
});

