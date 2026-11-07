import { describe, expect, it } from "vitest";
import { resolveExecutionWorkingDirectory } from "../apps/api/src/utils/execution-working-directory.js";

describe("execution working directory policy", () => {
  it("requires agent cwd for hub-integrated resolution", () => {
    expect(
      resolveExecutionWorkingDirectory({
        hubIntegrated: true,
        configuredDefault: "/workspace",
        toolContext: { workingDirectory: "/tmp/agent-app" },
      }),
    ).toBe("/tmp/agent-app");

    expect(
      resolveExecutionWorkingDirectory({
        hubIntegrated: true,
        configuredDefault: "/workspace",
        toolContext: undefined,
      }),
    ).toBeUndefined();
  });

  it("allows configured default for direct local proxy clients", () => {
    expect(
      resolveExecutionWorkingDirectory({
        hubIntegrated: false,
        configuredDefault: "/workspace",
        toolContext: undefined,
      }),
    ).toBe("/workspace");
  });
});
