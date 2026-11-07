import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AntigravityProvider } from "@agent-runtime-gateway/provider-antigravity";
import {
  AGY_CLI_PATH_ENV,
  defaultAgyPathCandidates,
} from "@agent-runtime-gateway/provider-antigravity/acp";

/**
 * REAL Antigravity image-turn check (offline by default).
 *
 * Runs a real ACP turn through the AntigravityProvider with actual PNG and
 * JPEG payloads read from fixtures, so both the provider block pipeline and
 * the model's own image understanding (the answer names the drawn color) are
 * verified against the live agy runtime. This closes the FEAT-002 gap where
 * JPEG inference had only fixture coverage.
 *
 * No credential material is exported, transported, or logged. Gated by
 * RUN_ANTIGRAVITY_ACP_TESTS=1 (opt-in) and a resolvable `agy` binary
 * (AGY_PATH env or ~/.gemini/bin/agy), so offline CI is unaffected.
 */
const RUN_REAL = process.env["RUN_ANTIGRAVITY_ACP_TESTS"] === "1";

function resolveAgyPath(): string | undefined {
  const fromEnv = process.env[AGY_CLI_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return defaultAgyPathCandidates().find((candidate) => fs.existsSync(candidate));
}

const agyPath = resolveAgyPath();
const REAL_TIMEOUT = 240_000;
const sandboxHome = process.env["ANTIGRAVITY_STORAGE_PATH"];

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "antigravity-images",
);
const workspace = join(dirname(fixturesRoot), "agy-acp-workspace");

function readImageBase64(fileName: string): string {
  return fs.readFileSync(join(fixturesRoot, fileName)).toString("base64");
}

function ensureWorkspace(): string {
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

describe.skipIf(!(RUN_REAL && agyPath !== undefined))(
  "Antigravity image turns (opt-in, real CLI)",
  () => {
    it(
      "answers a real PNG color question through the provider",
      async () => {
        const cwd = ensureWorkspace();
        const provider = new AntigravityProvider({
          defaultWorkingDirectory: cwd,
          homeDir: sandboxHome,
        });
        const run = await provider.execute({
          credential: { type: "local", value: "" },
          model: "antigravity:gemini-3.8-flash",
          sessionId: `real-images-png-${Date.now()}`,
          message:
            "The following image is a plain solid color. Reply with a single word: the color name.",
          workingDirectory: cwd,
          images: [
            {
              mimeType: "image/png",
              data: readImageBase64("red.png"),
            },
          ],
        });

        const result = await run.wait();
        expect(result.status).toBe("completed");
        expect(result.output?.text).toMatch(/red/i);
      },
      REAL_TIMEOUT,
    );

    it(
      "answers a real JPEG color question through the provider",
      async () => {
        const cwd = ensureWorkspace();
        const provider = new AntigravityProvider({
          defaultWorkingDirectory: cwd,
          homeDir: sandboxHome,
        });
        const run = await provider.execute({
          credential: { type: "local", value: "" },
          model: "antigravity:gemini-3.8-flash",
          sessionId: `real-images-jpeg-${Date.now()}`,
          message:
            "The following image is a plain solid color. Reply with a single word: the color name.",
          workingDirectory: cwd,
          images: [
            {
              mimeType: "image/jpeg",
              data: readImageBase64("blue.jpg"),
            },
          ],
        });

        const result = await run.wait();
        expect(result.status).toBe("completed");
        expect(result.output?.text).toMatch(/blue/i);
      },
      REAL_TIMEOUT,
    );
  },
);
