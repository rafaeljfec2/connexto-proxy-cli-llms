import path from "node:path";
import { describe, expect, it } from "vitest";
import { preferCompatibleRipgrepOnPath } from "../apps/api/src/utils/ripgrep-path.js";

describe("preferCompatibleRipgrepOnPath", () => {
  it("prepends @vscode/ripgrep to PATH when available", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin";
      delete process.env.RIPGREP_PATH;
      preferCompatibleRipgrepOnPath();
      expect(process.env.PATH?.split(path.delimiter)[0]).toContain("ripgrep");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
