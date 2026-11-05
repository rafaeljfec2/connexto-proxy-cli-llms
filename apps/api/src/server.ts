import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

function main(): void {
  const env = loadEnv();
  const app = buildApp();

  const server = app.listen(env.PORT, env.HOST, () => {
    process.stdout.write(
      `Gateway server listening at http://${env.HOST}:${env.PORT}\n`,
    );
  });

  server.on("error", (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`Received ${signal}, shutting down gracefully...\n`);
    server.close((err) => {
      if (err) {
        process.stderr.write(`Error during shutdown: ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write("Gateway server stopped.\n");
      process.exit(0);
    });

    // Force close if graceful shutdown hangs
    setTimeout(() => {
      process.stderr.write("Forced shutdown after timeout.\n");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
