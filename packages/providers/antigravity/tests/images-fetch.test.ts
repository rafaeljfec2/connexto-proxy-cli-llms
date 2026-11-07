import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ANTIGRAVITY_IMAGE_BYTES,
  MAX_IMAGE_REDIRECT_HOPS,
  resolveAgentImages,
  type PinnedTransport,
  type SafeLookupFn,
} from "../src/images/index.js";

/** Adapts a fetch-shaped spy to the pinned transport contract. */
function viaFetch(fetchImpl: typeof fetch): PinnedTransport {
  return ({ url, signal }) => fetchImpl(url.toString(), { signal });
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const TEXT_BYTES = Buffer.from("<html><body>x</body></html>", "ascii");

const PUBLIC_DNS: SafeLookupFn = (hostname) => {
  if (hostname === "unresolvable.invalid") {
    return Promise.reject(
      Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }),
    );
  }
  return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
};

function pngResponse(): Promise<Response> {
  return Promise.resolve(new Response(PNG_BYTES, { status: 200 }));
}

/** Spy fetch that serves a valid PNG and records every requested URL. */
function spyFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: unknown) => {
    calls.push(String(input));
    return pngResponse();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("safe image URL fetching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a public https URL and returns sniffed PNG bytes", async () => {
    const images = await resolveAgentImages([{ url: "https://example.com/a.png" }], {
      transport: viaFetch(pngResponse),
      lookup: PUBLIC_DNS,
    });

    expect(images).toEqual([{ mimeType: "image/png", data: PNG_BASE64 }]);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(
      resolveAgentImages([{ url: "ftp://example.com/a.png" }], {
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(HttpError);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      resolveAgentImages([{ url: "not a url" }], { lookup: PUBLIC_DNS }),
    ).rejects.toThrow(HttpError);
  });

  it("rejects URLs that embed credentials", async () => {
    const { fetchImpl, calls } = spyFetch();

    await expect(
      resolveAgentImages([{ url: "https://user:secret@example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/credentials/);
    expect(calls).toEqual([]);
  });

  it.each([
    "http://127.0.0.1/a.png",
    "http://10.1.2.3/a.png",
    "http://172.20.0.5/a.png",
    "http://192.168.1.7/a.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0:8080/a.png",
    "http://192.0.0.5/a.png",
    "https://[::1]/a.png",
    "https://[fe80::1]/a.png",
    "https://[fec0::1]/a.png",
    "https://[fd00::1]/a.png",
    "https://[100::1]/a.png",
    "https://[64:ff9b:1::1]/a.png",
    "https://[::ffff:127.0.0.1]/a.png",
    "https://[::ffff:169.254.4.3]/a.png",
    "https://[::ffff:0:10.0.0.1]/a.png",
    "https://[2002:7f00:1::]/a.png",
    "http://localhost/a.png",
  ])("rejects the forbidden address %s without fetching it", async (url) => {
    const { fetchImpl, calls } = spyFetch();

    await expect(
      resolveAgentImages([{ url }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(HttpError);
    expect(calls).toEqual([]);
  });

  it.each([
    "https://[::ffff:172.32.0.1]/a.png",
    "http://172.32.0.1/a.png",
    "http://93.184.216.34/a.png",
    "https://[2002:0808:0808::]/a.png",
  ])("allows the public address %s", async (url) => {
    const images = await resolveAgentImages([{ url }], {
      transport: viaFetch(pngResponse),
      lookup: PUBLIC_DNS,
    });

    expect(images).toEqual([{ mimeType: "image/png", data: PNG_BASE64 }]);
  });

  it("rejects hostnames whose DNS resolves to a private address without fetching", async () => {
    const { fetchImpl, calls } = spyFetch();
    const privateLookup: SafeLookupFn = () =>
      Promise.resolve([{ address: "10.0.0.9", family: 4 }]);

    await expect(
      resolveAgentImages([{ url: "https://intranet.example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: privateLookup,
      }),
    ).rejects.toThrow(/forbidden address/);
    expect(calls).toEqual([]);
  });

  it("rejects hostnames that fail DNS resolution", async () => {
    await expect(
      resolveAgentImages([{ url: "https://unresolvable.invalid/a.png" }], {
        transport: viaFetch(pngResponse),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(HttpError);
  });

  it("rejects multi-address lookups where any address is forbidden without fetching", async () => {
    const { fetchImpl, calls } = spyFetch();
    const mixedLookup: SafeLookupFn = () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);

    await expect(
      resolveAgentImages([{ url: "https://mixed.example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: mixedLookup,
      }),
    ).rejects.toThrow(/forbidden address/);
    expect(calls).toEqual([]);
  });

  it("rejects redirects that cross into a forbidden address and never requests it", async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("final")) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://10.9.9.9/a.png" },
          }),
        );
      }
      return pngResponse();
    }) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/redirect" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/forbidden address/);
    expect(calls).toEqual(["https://example.com/redirect"]);
  });

  it("follows a bounded redirect chain to the final image", async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: unknown) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/final" },
          }),
        );
      }
      return pngResponse();
    }) as unknown as typeof fetch;

    const images = await resolveAgentImages([{ url: "https://example.com/redirect" }], {
      transport: viaFetch(fetchImpl),
      lookup: PUBLIC_DNS,
    });

    expect(images).toEqual([{ mimeType: "image/png", data: PNG_BASE64 }]);
    expect(calls).toEqual([
      "https://example.com/redirect",
      "https://example.com/final",
    ]);
  });

  it("rejects redirect chains beyond the configured hop budget", async () => {
    const calls: string[] = [];
    const fetchImpl = (() => {
      calls.push("hop");
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://example.com/hop-${calls.length}` },
        }),
      );
    }) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/redirect" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/hop budget/);
    expect(calls.length).toBe(MAX_IMAGE_REDIRECT_HOPS + 1);
  });

  it("rejects payloads whose magic bytes are not an image", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(TEXT_BYTES, { status: 200 }),
      )) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(HttpError);
  });

  it("rejects non-2xx HTTP responses", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("not found", { status: 404 }),
      )) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/\(404\)/);
  });

  it("rejects a declared Content-Length above the byte limit before reading the body", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-length": String(MAX_ANTIGRAVITY_IMAGE_BYTES + 1) },
        }),
      )) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/byte limit/);
  });

  it("stops pulling the body shortly after the byte limit is exceeded", async () => {
    const chunkBytes = 64 * 1024;
    const totalChunks = 512;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x42));
      },
    });
    const fetchImpl = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
      }),
    ).rejects.toThrow(/byte limit/);
    const limitChunks = Math.ceil(MAX_ANTIGRAVITY_IMAGE_BYTES / chunkBytes);
    expect(pulls).toBeLessThanOrEqual(limitChunks + 4);
  });

  it("rejects when the fetch exceeds the configured timeout", async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("does not fetch when the caller AbortSignal is already aborted", async () => {
    const { fetchImpl, calls } = spyFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveAgentImages([{ url: "https://example.com/a.png" }], {
        transport: viaFetch(fetchImpl),
        lookup: PUBLIC_DNS,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(calls).toEqual([]);
  });
});
