import { startBridgeServer } from "../dist/server.js";

const PORT = 4318;
const TOKEN = "stage3-secure-token-xyz";

async function main() {
  console.log("=== STARTING STAGE 3 HOST BROWSER BRIDGE SERVER ===");
  console.log("Port:", PORT);
  console.log("Platform:", process.platform, "Node version:", process.version);

  process.env.BROWSER_BRIDGE_TOKEN = TOKEN;
  process.env.BROWSER_BRIDGE_PORT = String(PORT);

  const server = await startBridgeServer({
    port: PORT,
    host: "0.0.0.0",
    bridgeToken: TOKEN,
  });

  console.log("BRIDGE_SERVER_READY");

  // Keep running until signaled
  const shutdown = async () => {
    console.log("[BridgeServer] Closing server and sessions...");
    await server.close();
    console.log("[BridgeServer] Closed.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("FATAL SERVER ERROR:", err);
  process.exit(1);
});

