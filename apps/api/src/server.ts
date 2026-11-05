import { buildApp } from "./app.js";
import { loadEnv, loadEnvFileIfPresent } from "./config/env.js";
import { createLogger, setLogger } from "./utils/logger.js";

function main(): void {
  loadEnvFileIfPresent();
  const env = loadEnv();
  const logger = createLogger({
    format: env.LOG_FORMAT,
    level: env.LOG_LEVEL,
  });
  setLogger(logger);

  const app = buildApp(env);

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { host: env.HOST, port: env.PORT },
      `Gateway server listening at http://${env.HOST}:${env.PORT}`,
    );
  });

  server.on("error", (error: Error) => {
    logger.fatal({ err: error.message }, "Gateway server error encountered");
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, `Received ${signal}, shutting down gracefully...`);
    server.close((err) => {
      if (err) {
        logger.error({ err: err.message }, "Error during shutdown");
        process.exit(1);
      }
      logger.info("Gateway server stopped");
      process.exit(0);
    });

    // Force close if graceful shutdown hangs
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
