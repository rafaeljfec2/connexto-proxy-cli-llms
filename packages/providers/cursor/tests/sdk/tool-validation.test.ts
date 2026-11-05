import { describe, expect, it } from "vitest";
import { cursorSdkTestExports } from "../../src/cursor-sdk.js";

describe("Cursor SDK Tool Validation", () => {
  it("does not emit incomplete SDK tool-call starts to OpenCode", () => {
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({ name: "glob", arguments: {} }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({ name: "edit", arguments: {} }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { path: "package.json", oldText: "old" },
      }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { path: "package.json", newText: "new" },
      }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "write",
        arguments: { path: "package.json" },
      }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({ name: "shell", arguments: {} }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "mcp",
        arguments: { providerIdentifier: "filesystem" },
      }),
    ).toBe(false);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "glob",
        arguments: { targetDirectory: "src" },
      }),
    ).toBe(false);
  });

  it("allows SDK tool calls once required execution arguments are available", () => {
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "glob",
        arguments: { globPattern: "**/*.tsx" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "glob",
        arguments: { targetDirectory: "src/**/*.tsx" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "write",
        arguments: { path: "package.json", fileText: "" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "write",
        arguments: { filePath: "empty.txt", content: "" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { path: "package.json", oldText: "", newText: "{}" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { filePath: "package.json", old_str: "{}", replacement: "" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { path: "package.json", patch_content: "" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "shell",
        arguments: { command: "npm test" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "mcp",
        arguments: { providerIdentifier: "filesystem", toolName: "write_file" },
      }),
    ).toBe(true);
  });

  it("converts completed SDK streaming edits into OpenCode writes", () => {
    expect(
      cursorSdkTestExports.normalizeSdkToolCallForOpenCode({
        name: "edit",
        arguments: { path: "scripts/verify.mjs", streamContent: "console.log('ok')\n" },
      }),
    ).toEqual({
      name: "write",
      arguments: { path: "scripts/verify.mjs", fileText: "console.log('ok')\n" },
    });
    expect(
      cursorSdkTestExports.isEmittableSdkToolCall({
        name: "edit",
        arguments: { path: "scripts/verify.mjs", streamContent: "x" },
      }),
    ).toBe(true);
    expect(
      cursorSdkTestExports.normalizeSdkToolCallForOpenCode({
        name: "edit",
        arguments: { path: "scripts/empty.mjs", stream_content: "" },
      }),
    ).toEqual({
      name: "write",
      arguments: { path: "scripts/empty.mjs", fileText: "" },
    });
  });
});
