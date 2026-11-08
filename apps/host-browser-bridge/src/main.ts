import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startBridgeServer } from "./server.js";

// Load root .env if present
try {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const rootEnvPath = path.resolve(currentDir, "../../../.env");
  if (fs.existsSync(rootEnvPath)) {
    process.loadEnvFile?.(rootEnvPath);
  }
} catch {
  // Ignore env loading errors
}

async function main(): Promise<void> {
  const server = await startBridgeServer();

  const shutdown = async () => {
    console.log("[HostBrowserBridge] Shutting down gracefully...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[HostBrowserBridge] Fatal server error:", err);
  process.exit(1);
});

