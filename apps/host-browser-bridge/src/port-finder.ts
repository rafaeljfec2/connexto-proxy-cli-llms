import net from "node:net";

/**
 * Finds an available local TCP port on loopback (127.0.0.1).
 */
export async function findAvailableLocalPort(preferredPort?: number): Promise<number> {
  if (preferredPort !== undefined && preferredPort > 0) {
    const isFree = await isPortAvailable(preferredPort);
    if (isFree) {
      return preferredPort;
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on("error", (err) => {
      reject(err);
    });

    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
          } else {
            resolve(port);
          }
        });
      } else {
        server.close(() => {
          reject(new Error("Unable to obtain local port from server address"));
        });
      }
    });
  });
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen({ host: "127.0.0.1", port });
  });
}

