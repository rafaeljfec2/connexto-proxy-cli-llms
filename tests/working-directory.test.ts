import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertConfiguredWorkingDirectoryExists,
  resolveAgentWorkingDirectory,
} from "../apps/api/src/utils/working-directory.js";

describe("working directory helpers", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("prefers tool context over configured default", () => {
    const resolved = resolveAgentWorkingDirectory("/workspace", {
      workingDirectory: "/tmp/project",
    });
    expect(resolved).toBe(path.resolve("/tmp/project"));
  });

  it("falls back to configured default when tool context is absent", () => {
    expect(resolveAgentWorkingDirectory("/workspace", undefined)).toBe(
      path.resolve("/workspace"),
    );
  });

  it("returns undefined when neither context nor default is set", () => {
    expect(resolveAgentWorkingDirectory(undefined, undefined)).toBeUndefined();
  });

  it("validates that configured default exists and is a directory", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-workdir-"));
    expect(() => assertConfiguredWorkingDirectoryExists(tempDir!)).not.toThrow();
  });

  it("rejects missing configured default paths", () => {
    expect(() =>
      assertConfiguredWorkingDirectoryExists("/path/that/does/not/exist/for-gateway"),
    ).toThrow("does not exist");
  });
});
