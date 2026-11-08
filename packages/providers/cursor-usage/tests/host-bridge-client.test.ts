import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HostBrowserBridgeClient,
  BridgeUnauthorizedError,
  BridgeForbiddenError,
  BridgeSessionNotFoundError,
  BridgeError,
} from "../src/host-bridge-client.js";

describe("HostBrowserBridgeClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls /health without authorization header", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok", activeSessions: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = mockFetch;

    const client = new HostBrowserBridgeClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "test-token",
    });

    const res = await client.health();
    expect(res.status).toBe("ok");
    expect(res.activeSessions).toBe(2);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4318/health");
    expect((init.headers as Headers).get("Authorization")).toBeNull();
  });

  it("creates session with Bearer and x-bridge-token headers", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sessionId: "session-1",
            principalId: "user-alice",
            target: "cursor",
            status: "waiting_for_login",
            createdAt: "2026-11-07T12:00:00Z",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = mockFetch;

    const client = new HostBrowserBridgeClient({
      baseUrl: "http://127.0.0.1:4318",
      token: "secret-token",
    });

    const session = await client.createSession({
      principalId: "user-alice",
      target: "cursor",
      targetUrl: "https://cursor.com/login",
    });

    expect(session.sessionId).toBe("session-1");
    expect(session.status).toBe("waiting_for_login");

    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4318/internal/browser/sessions");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret-token");
    expect(headers.get("x-bridge-token")).toBe("secret-token");
  });

  it("maps 401 response to BridgeUnauthorizedError", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "Invalid token" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const client = new HostBrowserBridgeClient({ baseUrl: "http://127.0.0.1:4318" });

    await expect(
      client.createSession({ principalId: "u", target: "t" }),
    ).rejects.toThrow(BridgeUnauthorizedError);
  });

  it("maps 403 response to BridgeForbiddenError", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "Wrong principal" } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const client = new HostBrowserBridgeClient({ baseUrl: "http://127.0.0.1:4318" });

    await expect(client.getSession("s-1", "user-bob")).rejects.toThrow(
      BridgeForbiddenError,
    );
  });

  it("maps 404 response to BridgeSessionNotFoundError", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "Session not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const client = new HostBrowserBridgeClient({ baseUrl: "http://127.0.0.1:4318" });

    await expect(client.getSession("non-existent", "user-alice")).rejects.toThrow(
      BridgeSessionNotFoundError,
    );
  });

  it("handles request timeout", async () => {
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortError = new DOMException("The operation was aborted", "AbortError");
          reject(abortError);
        });
      });
    });

    const client = new HostBrowserBridgeClient({
      baseUrl: "http://127.0.0.1:4318",
      defaultTimeoutMs: 10,
    });

    await expect(
      client.createSession({ principalId: "u", target: "t" }),
    ).rejects.toThrow(BridgeError);
  });

  it("falls back to secondary host candidate when host.docker.internal fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      callCount++;
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (urlStr.includes("host.docker.internal")) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok", activeSessions: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const client = new HostBrowserBridgeClient({
      baseUrl: "http://host.docker.internal:4318",
    });

    const res = await client.health();
    expect(res.status).toBe("ok");
    expect(callCount).toBeGreaterThan(1);
  });
});
