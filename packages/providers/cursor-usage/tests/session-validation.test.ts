import { describe, expect, it } from "vitest";
import { isUsableStorageState } from "../src/session-validation.js";

describe("isUsableStorageState", () => {
  it("rejects undefined and empty cookies", () => {
    expect(isUsableStorageState(undefined)).toBe(false);
    expect(isUsableStorageState({ cookies: [], origins: [] })).toBe(false);
  });

  it("rejects cookies on unrelated domains", () => {
    expect(
      isUsableStorageState({
        cookies: [
          {
            name: "a",
            value: "b",
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    ).toBe(false);
  });

  it("accepts at least one cookie on a Cursor-related domain", () => {
    expect(
      isUsableStorageState({
        cookies: [
          {
            name: "session",
            value: "x",
            domain: ".cursor.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    ).toBe(true);
  });
});
