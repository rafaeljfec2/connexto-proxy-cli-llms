import { describe, expect, it } from "vitest";
import { cursorModelSelection } from "../src/model-selection.js";

describe("cursorModelSelection", () => {
  it("selects the non-fast Composer 2.5 variant by default", () => {
    expect(cursorModelSelection("composer-2.5")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
  });

  it("selects the fast Composer 2.5 variant only for its explicit model ID", () => {
    expect(cursorModelSelection("composer-2.5-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("preserves unrelated Cursor model IDs without variant parameters", () => {
    expect(cursorModelSelection("grok-4.6")).toEqual({ id: "grok-4.6" });
  });
});
