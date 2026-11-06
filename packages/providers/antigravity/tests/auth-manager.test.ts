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

  it("supports loopback redirect URI as default when configured", async () => {
    const manager = new AntigravityAuthManager({
      defaultRedirectUri: "http://127.0.0.1:3000/v1/antigravity/auth/callback",
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    const start = await manager.startAuth();
    expect(start.authUrl).toContain(
      encodeURIComponent("http://127.0.0.1:3000/v1/antigravity/auth/callback"),
    );
  });

  it("exchanges code for tokens using tokenExchanger and extracts email from JWT", async () => {
    // Generate a mock JWT ID token with email payload
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ email: "oauth-user@example.com", sub: "12345" }),
    ).toString("base64url");
    const mockIdToken = `${header}.${payload}.mock-signature`;

    let exchangerCalledWith:
      | { clientId: string; code: string; codeVerifier: string; redirectUri: string }
      | undefined;
    let tokensPersistedEmail: string | undefined;

    const manager = new AntigravityAuthManager({
      defaultRedirectUri: "http://127.0.0.1:3000/v1/antigravity/auth/callback",
      tokenExchanger: (params) => {
        exchangerCalledWith = params;
        return Promise.resolve({
          access_token: "ya29.mock-access-token",
          refresh_token: "1//mock-refresh-token",
          id_token: mockIdToken,
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
      onTokensPersisted: (_tokens, email) => {
        tokensPersistedEmail = email;
        return Promise.resolve();
      },
      accountDetector: () => Promise.resolve({ authenticated: false }),
    });

    const start = await manager.startAuth();
    const result = await manager.handleCallback({
      state: start.state,
      code: "google-auth-code-test",
    });

    expect(result.status).toBe("completed");
    expect(result.account).toBe("oauth-user@example.com");
    expect(tokensPersistedEmail).toBe("oauth-user@example.com");
    expect(exchangerCalledWith).toBeDefined();
    expect(exchangerCalledWith?.code).toBe("google-auth-code-test");
    expect(exchangerCalledWith?.redirectUri).toBe(
      "http://127.0.0.1:3000/v1/antigravity/auth/callback",
    );
    expect(exchangerCalledWith?.codeVerifier).toBeDefined();
  });
});
