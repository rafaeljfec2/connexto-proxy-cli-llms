import { describe, it, expect } from "vitest";
import { findAvailableLocalPort } from "../src/port-finder.js";

describe("port-finder", () => {
  it("finds an available local port on loopback", async () => {
    const port = await findAvailableLocalPort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it("finds two distinct consecutive ports", async () => {
    const port1 = await findAvailableLocalPort();
    const port2 = await findAvailableLocalPort();
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });
});

