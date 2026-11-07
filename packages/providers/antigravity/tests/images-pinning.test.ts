import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAgentImages,
  type PinnedRequest,
  type PinnedTransport,
  type SafeLookupFn,
} from "../src/images/index.js";
import {
  createNodePinnedTransport,
  nodePinnedTransport,
} from "../src/images/transport.js";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

interface Connection {
  readonly host: string;
  readonly address: string;
  readonly family: 4 | 6;
}

/** Records the adapter contract (host + pinned address) without touching the network. */
function recordingTransport(respond: (request: PinnedRequest) => Response): {
  transport: PinnedTransport;
  connections: Connection[];
} {
  const connections: Connection[] = [];
  const transport: PinnedTransport = (request) => {
    connections.push({
      host: request.url.hostname,
      address: request.address,
      family: request.family,
    });
    return Promise.resolve(respond(request));
  };
  return { transport, connections };
}

function pngResponse(): Response {
  return new Response(PNG_BYTES, { status: 200 });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

function track(server: Server | HttpsServer): void {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

async function listenHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host = "127.0.0.1",
): Promise<number> {
  const server = createHttpServer(handler);
  track(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

describe("adapter contract", () => {
  it("forwards the first validated address and the original hostname to the transport", async () => {
    const lookup: SafeLookupFn = () =>
      Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    const { transport, connections } = recordingTransport(pngResponse);

    await resolveAgentImages([{ url: "https://images.example.com/a.png" }], {
      transport,
      lookup,
    });

    expect(connections).toEqual([
      { host: "images.example.com", address: "93.184.216.34", family: 4 },
    ]);
  });

  it("pins the first of several public records", async () => {
    const lookup: SafeLookupFn = () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "93.184.216.35", family: 4 },
      ]);
    const { transport, connections } = recordingTransport(pngResponse);

    await resolveAgentImages([{ url: "https://multi.example.com/a.png" }], {
      transport,
      lookup,
    });

    expect(connections.map((connection) => connection.address)).toEqual([
      "93.184.216.34",
    ]);
  });

  it("rejects a non-IP DNS record without connecting", async () => {
    const { transport, connections } = recordingTransport(pngResponse);

    await expect(
      resolveAgentImages([{ url: "https://odd.example.com/a.png" }], {
        transport,
        lookup: () => Promise.resolve([{ address: "foo", family: 4 }]),
      }),
    ).rejects.toThrow(/forbidden address/);
    expect(connections).toEqual([]);
  });

  it("resolves each host once, so a rebinding second answer is never used", async () => {
    let lookups = 0;
    const lookup: SafeLookupFn = () => {
      lookups += 1;
      const address = lookups === 1 ? "93.184.216.34" : "10.0.0.9";
      return Promise.resolve([{ address, family: 4 }]);
    };
    const { transport, connections } = recordingTransport(pngResponse);

    await resolveAgentImages([{ url: "https://rebind.example.com/a.png" }], {
      transport,
      lookup,
    });

    expect(lookups).toBe(1);
    expect(connections.map((connection) => connection.address)).toEqual([
      "93.184.216.34",
    ]);
  });

  it("pins each redirect hop to its own validated address", async () => {
    const addresses = new Map<string, string>([
      ["a.example.com", "93.184.216.34"],
      ["b.example.com", "93.184.216.35"],
    ]);
    const lookup: SafeLookupFn = (hostname) => {
      const address = addresses.get(hostname);
      return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
    };
    const { transport, connections } = recordingTransport((request) =>
      request.url.hostname === "a.example.com"
        ? redirectTo("https://b.example.com/final.png")
        : pngResponse(),
    );

    await resolveAgentImages([{ url: "https://a.example.com/start.png" }], {
      transport,
      lookup,
    });

    expect(connections).toEqual([
      { host: "a.example.com", address: "93.184.216.34", family: 4 },
      { host: "b.example.com", address: "93.184.216.35", family: 4 },
    ]);
  });

  it("never connects to a redirect target whose DNS answer is forbidden", async () => {
    const addresses = new Map<string, string>([
      ["a.example.com", "93.184.216.34"],
      ["rebind.example.com", "127.0.0.1"],
    ]);
    const lookup: SafeLookupFn = (hostname) => {
      const address = addresses.get(hostname);
      return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
    };
    const { transport, connections } = recordingTransport(() =>
      redirectTo("https://rebind.example.com/final.png"),
    );

    await expect(
      resolveAgentImages([{ url: "https://a.example.com/start.png" }], {
        transport,
        lookup,
      }),
    ).rejects.toThrow(/forbidden address/);
    expect(connections.map((connection) => connection.host)).toEqual(["a.example.com"]);
  });

  it("pins IPv6 literals with the IPv6 family and without brackets", async () => {
    const { transport, connections } = recordingTransport(pngResponse);

    await resolveAgentImages([{ url: "https://[2002:0808:0808::]/a.png" }], {
      transport,
      lookup: () => Promise.resolve([]),
    });

    expect(connections).toEqual([
      { host: "[2002:808:808::]", address: "2002:808:808::", family: 6 },
    ]);
  });

  it("cancels DNS resolution that never settles when the timeout fires", async () => {
    const { transport, connections } = recordingTransport(pngResponse);

    await expect(
      resolveAgentImages([{ url: "https://hang.example.com/a.png" }], {
        transport,
        lookup: () => new Promise<never>(() => undefined),
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
    expect(connections).toEqual([]);
  });
});

describe("pinned socket (nodePinnedTransport)", () => {
  it("sends the original hostname as Host and never resolves DNS at connect time", async () => {
    const seenHosts: string[] = [];
    const port = await listenHttp((req, res) => {
      seenHosts.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_BYTES);
    });

    const response = await nodePinnedTransport({
      url: new URL(`http://pinned.invalid:${port}/a.png`),
      address: "127.0.0.1",
      family: 4,
      signal: new AbortController().signal,
    });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(seenHosts).toEqual([`pinned.invalid:${port}`]);
  });

  it("opens a new socket to the new pinned address instead of reusing a pooled one", async () => {
    const localAddresses: string[] = [];
    const port = await listenHttp((req, res) => {
      localAddresses.push(req.socket.localAddress ?? "");
      res.writeHead(200);
      res.end("ok");
    }, "0.0.0.0");

    const first = await nodePinnedTransport({
      url: new URL(`http://pinned.invalid:${port}/a.png`),
      address: "127.0.0.1",
      family: 4,
      signal: new AbortController().signal,
    });
    await first.arrayBuffer();
    const second = await nodePinnedTransport({
      url: new URL(`http://pinned.invalid:${port}/a.png`),
      address: "127.0.0.2",
      family: 4,
      signal: new AbortController().signal,
    });
    await second.arrayBuffer();

    expect(localAddresses).toEqual(["127.0.0.1", "127.0.0.2"]);
  });

  it.each([204, 304])(
    "returns a null body for status %i instead of constructing an invalid Response",
    async (status) => {
      const port = await listenHttp((_req, res) => {
        res.writeHead(status);
        res.end();
      });

      const response = await nodePinnedTransport({
        url: new URL(`http://pinned.invalid:${port}/a.png`),
        address: "127.0.0.1",
        family: 4,
        signal: new AbortController().signal,
      });

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    },
  );

  it("cancels an in-flight pinned connection when the signal aborts", async () => {
    const port = await listenHttp(() => {
      // Never responds: the request must be cancelled by the caller.
    });
    const controller = new AbortController();

    const pending = nodePinnedTransport({
      url: new URL(`http://pinned.invalid:${port}/a.png`),
      address: "127.0.0.1",
      family: 4,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await expect(pending).rejects.toThrow();
  });
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("pinned TLS (nodePinnedTransport over https)", () => {
  it("verifies the certificate for the original hostname and sends it as SNI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinned-tls-"));
    closers.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const generated = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=pinned.test",
      "-addext",
      "subjectAltName=DNS:pinned.test",
    ]);
    expect(generated.status).toBe(0);

    const seen: { host?: string; sni?: string } = {};
    const server = createHttpsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        seen.host = req.headers.host;
        const servername = (req.socket as TLSSocket).servername;
        seen.sni = typeof servername === "string" ? servername : undefined;
        res.writeHead(200);
        res.end("ok");
      },
    );
    track(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const transport = createNodePinnedTransport({ ca: readFileSync(certPath) });
    const response = await transport({
      url: new URL(`https://pinned.test:${port}/a.png`),
      address: "127.0.0.1",
      family: 4,
      signal: new AbortController().signal,
    });

    expect(response.status).toBe(200);
    expect(seen.host).toBe(`pinned.test:${port}`);
    expect(seen.sni).toBe("pinned.test");
  });

  it("rejects a certificate that does not match the original hostname", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinned-tls-"));
    closers.push(() => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    });
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=pinned.test",
      "-addext",
      "subjectAltName=DNS:pinned.test",
    ]);
    const server = createHttpsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    );
    track(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const transport = createNodePinnedTransport({ ca: readFileSync(certPath) });
    await expect(
      transport({
        url: new URL(`https://other.test:${port}/a.png`),
        address: "127.0.0.1",
        family: 4,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});
