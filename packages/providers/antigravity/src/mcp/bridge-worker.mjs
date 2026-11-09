#!/usr/bin/env node
import net from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("Usage: node bridge-worker.mjs <socketPath>\n");
  process.exit(1);
}

const socket = net.connect(socketPath, () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("error", (err) => {
  process.stderr.write(`Bridge worker socket error: ${err.message}\n`);
  process.exit(1);
});

socket.on("close", () => {
  process.exit(0);
});

process.stdin.on("end", () => {
  socket.end();
});

