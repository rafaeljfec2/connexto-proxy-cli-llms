import { describe, expect, it } from "vitest";
import {
  AntigravityAuthManager,
  AuthorizationDeniedError,
  InvalidStateError,
  OperationExpiredError,
} from "../src/index.js";

describe("AntigravityAuthManager Unit Tests", () => {
  it("starts auth flow and creates a valid pending operation with S256 PKCE", async () => {
    const manager = new AntigravityAuthManager({
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    const start = await manager.startAuth();

    expect(start.operationId).toBeDefined();
    expect(start.status).toBe("pending");
    expect(start.state).toBeDefined();
    expect(start.authUrl).toContain("https://accounts.google.com/o/oauth2/auth");
    expect(start.authUrl).toContain("code_challenge_method=S256");
    expect(start.authUrl).toContain(encodeURIComponent(start.state));
    expect(start.authUrl).toContain(
      "https%3A%2F%2Fantigravity.google%2Foauth-callback",
    );

    const op = manager.getOperation(start.operationId);
    expect(op).toBeDefined();
    expect(op?.status).toBe("pending");
  });

  it("completes auth flow when valid state and code are provided", async () => {
    const manager = new AntigravityAuthManager({
      accountDetector: () =>
        Promise.resolve({
          authenticated: true,
          account: "developer@example.com",
        }),
    });

    const start = await manager.startAuth();
    const result = await manager.handleCallback({
      state: start.state,
      code: "valid-auth-code-12345",
    });

    expect(result.status).toBe("completed");
    expect(result.account).toBe("developer@example.com");
    expect(result.operationId).toBe(start.operationId);

    const op = manager.getOperation(start.operationId);
    expect(op?.status).toBe("completed");
    expect(op?.account).toBe("developer@example.com");
  });

  it("rejects callback with invalid or missing state", async () => {
    const manager = new AntigravityAuthManager({
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    await manager.startAuth();

    await expect(
      manager.handleCallback({ state: "unknown-state", code: "any-code" }),
    ).rejects.toThrow(InvalidStateError);

    await expect(
      manager.handleCallback({ state: "", code: "any-code" }),
    ).rejects.toThrow(InvalidStateError);
  });

  it("handles authorization denial properly and records failure", async () => {
    const manager = new AntigravityAuthManager({
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    const start = await manager.startAuth();

    await expect(
      manager.handleCallback({
        state: start.state,
        error: "access_denied",
        error_description: "The user denied access",
      }),
    ).rejects.toThrow(AuthorizationDeniedError);

    const op = manager.getOperation(start.operationId);
    expect(op?.status).toBe("failed");
    expect(op?.error).toContain("The user denied access");
  });

  it("marks operation as expired and rejects after TTL expires", async () => {
    const manager = new AntigravityAuthManager({
      operationTtlMs: -1000, // already expired
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    const start = await manager.startAuth();

    await expect(
      manager.handleCallback({
        state: start.state,
        code: "some-code",
      }),
    ).rejects.toThrow(OperationExpiredError);

    const op = manager.getOperation(start.operationId);
    expect(op?.status).toBe("expired");
  });

  it("returns status with viability gate and limitations without exposing secrets", async () => {
    const manager = new AntigravityAuthManager({
      accountDetector: () =>
        Promise.resolve({
          authenticated: true,
          account: "test-user@connexto.com",
        }),
    });

    const status = await manager.getStatus();

    expect(status.authenticated).toBe(true);
    expect(status.account).toBe("test-user@connexto.com");
    expect(status.viabilityGate).toBe("PARTIALLY_SUPPORTED");
    expect(status.limitations.length).toBeGreaterThan(0);
    expect(status.limitations[0]).toContain("Google Antigravity personal OAuth");
    expect(status).not.toHaveProperty("access_token");
    expect(status).not.toHaveProperty("refresh_token");
    expect(status).not.toHaveProperty("token");
    expect(status).not.toHaveProperty("secret");
  });

  it("triggers optional cli spawner hook if provided", async () => {
    let spawned = false;
    const manager = new AntigravityAuthManager({
      cliLoginSpawner: () => {
        spawned = true;
        return Promise.resolve();
      },
    });

    await manager.startAuth();
    expect(spawned).toBe(true);
  });
});
