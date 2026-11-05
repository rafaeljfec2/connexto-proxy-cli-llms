import {
  createServer,
  request as createHttpRequest,
  type ClientRequest,
} from "node:http";
import type { AgentProvider } from "@agent-runtime-gateway/core";
import { buildApp } from "@agent-runtime-gateway/api";
import { getGatewayServices } from "../../apps/api/src/services/gateway.js";

interface ExecutorRegistryAccess {
  readonly router: {
    readonly registry: {
      readonly providers: Map<string, AgentProvider>;
    };
  };
}

const services = getGatewayServices();
const providers = (services.executor as unknown as ExecutorRegistryAccess).router
  .registry.providers;
const originalProvider = providers.get("cursor");
export const app = buildApp({ HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined });
const server = createServer(app);
let serverPort = 0;

export function hasOriginalProvider(): boolean {
  return originalProvider !== undefined;
}

export function installProvider(provider: AgentProvider): void {
  providers.set("cursor", provider);
}

export function restoreProvider(): void {
  if (originalProvider) installProvider(originalProvider);
}

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected an IP server address"));
        return;
      }
      serverPort = address.port;
      resolve();
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function disconnectStreamAfterDelta(
  path: string,
  body: Record<string, unknown>,
  marker: string,
  onClosed: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const clientRequest = createHttpRequest(
      {
        host: "127.0.0.1",
        port: serverPort,
        method: "POST",
        path,
        headers: {
          Authorization: "Bearer synthetic-cursor-key",
          "Content-Type": "application/json",
          Connection: "close",
        },
      },
      (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("close", onClosed);
        response.on("error", () => undefined);
        response.on("data", (chunk: string) => {
          received += chunk;
          if (received.includes(marker)) {
            resolve(received);
            clientRequest.destroy();
          }
        });
      },
    );
    clientRequest.on("error", () => reject(new Error("HTTP request failed")));
    clientRequest.end(JSON.stringify(body));
  });
}

export function startPendingChatRequest(stream = false): {
  readonly request: ClientRequest;
  readonly socketClosed: Promise<void>;
} {
  let resolveSocketClosed: () => void = () => undefined;
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const clientRequest = createHttpRequest({
    host: "127.0.0.1",
    port: serverPort,
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      Authorization: "Bearer synthetic-cursor-key",
      "Content-Type": "application/json",
    },
  });
  clientRequest.on("error", () => undefined);
  clientRequest.on("socket", (socket) => socket.once("close", resolveSocketClosed));
  clientRequest.end(
    JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "pending cancellation test" }],
      stream,
    }),
  );
  return { request: clientRequest, socketClosed };
}
