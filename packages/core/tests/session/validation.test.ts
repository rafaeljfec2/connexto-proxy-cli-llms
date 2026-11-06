import { describe, expect, it } from "vitest";
import {
  InvalidSessionKeyError,
  validateKey,
  validateNamespace,
  validateNamespaceAndKey,
} from "../../src/session/index.js";

describe("Session Identifier Validation", () => {
  it("accepts valid alphanumeric, hyphen, and underscore identifiers", () => {
    expect(() => validateNamespace("cursor")).not.toThrow();
    expect(() => validateNamespace("antigravity-provider_v1")).not.toThrow();
    expect(() => validateKey("session-123_abc")).not.toThrow();
    expect(() => validateNamespaceAndKey("cursor", "sess-456")).not.toThrow();
  });

  it("rejects path traversal and directory separators in namespace", () => {
    expect(() => validateNamespace("..")).toThrow(InvalidSessionKeyError);
    expect(() => validateNamespace("../escape")).toThrow(InvalidSessionKeyError);
    expect(() => validateNamespace("folder/subfolder")).toThrow(InvalidSessionKeyError);
    expect(() => validateNamespace("folder\\subfolder")).toThrow(
      InvalidSessionKeyError,
    );
    expect(() => validateNamespace("")).toThrow(InvalidSessionKeyError);
  });

  it("rejects path traversal and directory separators in key", () => {
    expect(() => validateKey("..")).toThrow(InvalidSessionKeyError);
    expect(() => validateKey("../../passwd")).toThrow(InvalidSessionKeyError);
    expect(() => validateKey("key/with/slash")).toThrow(InvalidSessionKeyError);
    expect(() => validateKey("key\\with\\backslash")).toThrow(InvalidSessionKeyError);
    expect(() => validateKey("key with spaces")).toThrow(InvalidSessionKeyError);
    expect(() => validateKey("")).toThrow(InvalidSessionKeyError);
  });
});
