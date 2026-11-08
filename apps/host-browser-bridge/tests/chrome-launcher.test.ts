import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { ChromeLauncher } from "../src/chrome-launcher.js";
import { ChromeLaunchError } from "../src/types.js";

describe("ChromeLauncher", () => {
  it("resolves session user data dir without security violation for custom isolated root", () => {
    const launcher = new ChromeLauncher();
    const isolatedRoot = path.join(os.tmpdir(), "connexto-test-profiles");
    const sessionDir = launcher.resolveSessionUserDataDir("session-123", isolatedRoot);

    expect(sessionDir).toContain("session-123");
    expect(sessionDir).toContain("connexto-test-profiles");
  });

  it("throws security error if profile matches Windows personal Chrome profile", () => {
    const launcher = new ChromeLauncher();
    const originalLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local";

      if (process.platform === "win32") {
        expect(() => {
          launcher.assertNotPersonalProfile("C:\\Users\\testuser\\AppData\\Local\\Google\\Chrome\\User Data");
        }).toThrow(ChromeLaunchError);

        expect(() => {
          launcher.assertNotPersonalProfile("C:\\Users\\testuser\\AppData\\Local\\Google\\Chrome\\User Data\\Default");
        }).toThrow(ChromeLaunchError);
      }
    } finally {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it("resolves valid executable when overridePath exists", () => {
    const launcher = new ChromeLauncher();
    const currentFile = new URL(import.meta.url).pathname;
    const resolved = launcher.resolveChromeExecutable(currentFile);
    expect(resolved).toBe(currentFile);
  });

  it("throws ChromeLaunchError when executable does not exist", () => {
    const launcher = new ChromeLauncher();
    expect(() => {
      launcher.resolveChromeExecutable("/path/that/definitely/does/not/exist/chrome.exe");
    }).toThrow(ChromeLaunchError);
  });
});

