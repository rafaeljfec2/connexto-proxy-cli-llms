import { describe, expect, it } from "vitest";
import {
  buildChromiumLaunchArgs,
  resolveChromiumNoSandbox,
} from "../src/chrome-launch.js";

describe("chrome launch args", () => {
  it("omits no-sandbox for headed when explicit unset", () => {
    expect(resolveChromiumNoSandbox({ headless: false })).toBe(false);
    const args = buildChromiumLaunchArgs(false);
    expect(args).not.toContain("--no-sandbox");
  });

  it("includes no-sandbox for headless by default", () => {
    expect(resolveChromiumNoSandbox({ headless: true })).toBe(true);
    const args = buildChromiumLaunchArgs(true);
    expect(args).toContain("--no-sandbox");
  });

  it("honours explicit no-sandbox override", () => {
    expect(
      resolveChromiumNoSandbox({ headless: false, explicit: true }),
    ).toBe(true);
  });
});
