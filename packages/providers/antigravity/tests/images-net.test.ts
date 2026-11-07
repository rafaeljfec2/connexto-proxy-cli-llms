import { describe, expect, it } from "vitest";
import { isForbiddenInetAddress } from "../src/images/index.js";

describe("forbidden address classification", () => {
  it("reports IPv6 loopback with its own reason", () => {
    expect(isForbiddenInetAddress("::1")).toBe("IPv6 loopback (::1)");
    expect(isForbiddenInetAddress("[::1]")).toBe("IPv6 loopback (::1)");
  });

  it.each(["::808:808", "[::0808:0808]"])(
    "blocks the deprecated IPv4-compatible form %s",
    (address) => {
      expect(isForbiddenInetAddress(address)).toBe("IPv4-compatible IPv6 (::/96)");
    },
  );

  it("still allows public global unicast addresses", () => {
    expect(isForbiddenInetAddress("2606:4700:4700::1111")).toBeUndefined();
    expect(isForbiddenInetAddress("93.184.216.34")).toBeUndefined();
  });
});
