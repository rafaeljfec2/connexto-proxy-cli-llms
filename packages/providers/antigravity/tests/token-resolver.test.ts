import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AntigravityTokenResolver } from "../src/index.js";

describe("AntigravityTokenResolver Unit Test Suite", () => {
  it("resolves valid unexpired credentials from antigravity-oauth-token file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-test-"));
    const tokenDir = path.join(tmpDir, ".gemini", "antigravity-cli");
    await fs.mkdir(tokenDir, { recursive: true });

    const tokenPayload = {
      token: {
        access_token: "test-valid-access-token",
        refresh_token: "test-refresh-token",
        expiry: new Date(Date.now() + 3600_000).toISOString(),
      },
      auth_method: "consumer",
      id_token_email: "tester@example.com",
    };

    await fs.writeFile(
      path.join(tokenDir, "antigravity-oauth-token"),
      JSON.stringify(tokenPayload),
      "utf8",
    );

    const resolver = new AntigravityTokenResolver({ homeDir: tmpDir });
    const creds = await resolver.resolveCredentials();

    expect(creds).toBeDefined();
    expect(creds?.accessToken).toBe("test-valid-access-token");
    expect(creds?.email).toBe("tester@example.com");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("refreshes expired token and updates file on disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-test-"));
    const tokenDir = path.join(tmpDir, ".gemini", "antigravity-cli");
    await fs.mkdir(tokenDir, { recursive: true });

    const tokenPayload = {
      token: {
        access_token: "test-expired-access-token",
        refresh_token: "test-refresh-token",
        expiry: new Date(Date.now() - 3600_000).toISOString(),
      },
      auth_method: "consumer",
      id_token_email: "tester@example.com",
    };

    const filePath = path.join(tokenDir, "antigravity-oauth-token");
    await fs.writeFile(filePath, JSON.stringify(tokenPayload), "utf8");

    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-refreshed-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
      );
    });

    const resolver = new AntigravityTokenResolver({
      homeDir: tmpDir,
      fetchFn: mockFetch,
    });

    const creds = await resolver.resolveCredentials();

    expect(creds).toBeDefined();
    expect(creds?.accessToken).toBe("new-refreshed-token");
    expect(creds?.email).toBe("tester@example.com");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify file on disk was updated
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(saved.token.access_token).toBe("new-refreshed-token");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when refresh fails and token is expired", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-test-"));
    const tokenDir = path.join(tmpDir, ".gemini", "antigravity-cli");
    await fs.mkdir(tokenDir, { recursive: true });

    const tokenPayload = {
      token: {
        access_token: "test-expired-access-token",
        refresh_token: "revoked-refresh-token",
        expiry: new Date(Date.now() - 3600_000).toISOString(),
      },
      auth_method: "consumer",
    };

    await fs.writeFile(
      path.join(tokenDir, "antigravity-oauth-token"),
      JSON.stringify(tokenPayload),
      "utf8",
    );

    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    });

    const resolver = new AntigravityTokenResolver({
      homeDir: tmpDir,
      fetchFn: mockFetch,
    });

    const creds = await resolver.resolveCredentials();
    expect(creds).toBeUndefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects email from google_accounts.json", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-test-"));
    const geminiDir = path.join(tmpDir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });

    await fs.writeFile(
      path.join(geminiDir, "google_accounts.json"),
      JSON.stringify({ active: "active-account@gmail.com" }),
      "utf8",
    );

    const resolver = new AntigravityTokenResolver({ homeDir: tmpDir });
    const email = await resolver.detectAccountEmail();
    expect(email).toBe("active-account@gmail.com");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
