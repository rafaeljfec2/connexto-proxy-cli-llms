import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

function main(): void {
  const env = loadEnv();
  const app = buildApp();

  const server = app.listen(env.PORT, env.HOST);

  server.on("error", (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

main();
