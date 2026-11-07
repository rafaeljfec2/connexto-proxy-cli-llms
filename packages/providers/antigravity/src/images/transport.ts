import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

/**
 * A single outbound HTTP exchange pinned to an address that already passed the
 * SSRF checks. `url` keeps the original hostname for SNI, certificate
 * verification and the Host header; `address` is the only address the socket
 * may connect to.
 */
export interface PinnedRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly signal: AbortSignal;
}

export type PinnedTransport = (request: PinnedRequest) => Promise<Response>;

export interface NodePinnedTransportOptions {
  /** Extra trusted CA certificates. Used by tests; production leaves it unset. */
  readonly ca?: string | Buffer;
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Builds a transport on `node:http`/`node:https`. The `lookup` hook returns the
 * validated address without performing DNS, so the socket cannot be redirected
 * by a second resolution (DNS rebinding). `agent: false` disables connection
 * pooling: a keep-alive socket opened for one pinned address must never serve a
 * request pinned to another.
 */
export function createNodePinnedTransport(
  options: NodePinnedTransportOptions = {},
): PinnedTransport {
  return (request) => {
    const { url, address, family, signal } = request;
    const isHttps = url.protocol === "https:";
    const send = isHttps ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const outbound = send({
        protocol: url.protocol,
        hostname: stripBrackets(url.hostname),
        port: url.port === "" ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "image/png, image/jpeg;q=0.9, */*;q=0.1" },
        agent: false,
        lookup: pinnedLookup(address, family),
        signal,
        ...(isHttps && options.ca !== undefined ? { ca: options.ca } : {}),
      });
      outbound.once("error", reject);
      outbound.once("response", (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new Error(`Unsupported HTTP status ${status}.`));
          return;
        }
        const body = NULL_BODY_STATUSES.has(status)
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers: toHeaders(incoming.headers) }));
      });
      outbound.end();
    });
  };
}

/** Default transport used in production. */
export const nodePinnedTransport: PinnedTransport = createNodePinnedTransport();
