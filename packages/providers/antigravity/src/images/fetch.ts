import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import { isIP } from "node:net";
import type { ReadableStreamReadResult } from "node:stream/web";
import {
  DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
  MAX_ANTIGRAVITY_IMAGE_BYTES,
  MAX_IMAGE_REDIRECT_HOPS,
  type SafeLookupFn,
} from "./config.js";
import { isForbiddenInetAddress } from "./net.js";
import { nodePinnedTransport, type PinnedTransport } from "./transport.js";

export interface SafeFetchOptions {
  readonly transport?: PinnedTransport;
  readonly lookup: SafeLookupFn;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

function error(message: string, param = "image_url"): HttpError {
  return new HttpError(message, 400, "invalid_request_error", param);
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function rejectLocalHostname(hostname: string): void {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw error("Image URL points to a local hostname.");
  }
}

function familyOf(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

/** Rejects with the abort reason as soon as `signal` fires, even if `promise` never settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * Validates a URL for outbound access and returns the single address the
 * connection must use. Every address the host may resolve to is checked; the
 * first validated record is pinned so the transport never resolves DNS again.
 */
async function assertSafeOutboundUrl(
  target: URL,
  lookup: SafeLookupFn,
  signal: AbortSignal,
): Promise<PinnedAddress> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw error("Image URL must use http or https.");
  }
  if (target.username !== "" || target.password !== "") {
    throw error("Image URL must not contain credentials.");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const isIpAddress = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");

  if (isForbiddenInetAddress(hostname) !== undefined) {
    throw error("Image URL points to a forbidden address.");
  }
  if (isIpAddress) {
    return { address: hostname, family: familyOf(hostname) };
  }

  rejectLocalHostname(hostname);
  let records: Awaited<ReturnType<SafeLookupFn>> = [];
  let lookupFailure: unknown;
  try {
    records = await raceAbort(lookup(hostname), signal);
  } catch (cause) {
    if (signal.aborted) {
      throw cause;
    }
    lookupFailure = cause;
    records = [];
  }
  if (records.length === 0) {
    throw Object.assign(error("Image URL host could not be resolved."), {
      cause: lookupFailure,
    });
  }
  for (const record of records) {
    if (
      isIP(record.address) === 0 ||
      isForbiddenInetAddress(record.address) !== undefined
    ) {
      throw error("Image URL host resolves to a forbidden address.");
    }
  }
  const pinned = records[0];
  return { address: pinned.address, family: familyOf(pinned.address) };
}

/** Reads a response body while enforcing the payload byte limit. */
async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    return readBufferLimited(await response.arrayBuffer(), maxBytes);
  }
  const reader = stream.getReader();
  try {
    const parts: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (next.done) {
        break;
      }
      received += next.value.byteLength;
      if (received > maxBytes) {
        throw error(`Image exceeds the ${maxBytes} byte limit.`);
      }
      parts.push(next.value);
    }
    const total = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      total.set(part, offset);
      offset += part.byteLength;
    }
    return total;
  } finally {
    // Stop the transfer when the limit was hit before the body finished.
    void reader.cancel().catch(() => undefined);
  }
}

function readBufferLimited(buffer: ArrayBuffer, maxBytes: number): Uint8Array {
  if (buffer.byteLength > maxBytes) {
    throw error(`Image exceeds the ${maxBytes} byte limit.`);
  }
  return new Uint8Array(buffer);
}

/**
 * Fetches an image URL with SSRF protections. Every hop (including redirects) is
 * validated, and its connection is pinned to the validated address. The payload
 * is limited while streaming, and the whole operation honours a timeout and the
 * caller's AbortSignal.
 */
export async function fetchSafeImageBytes(
  url: string,
  options: SafeFetchOptions,
): Promise<Uint8Array> {
  const isCallerAborted = (): boolean => options.signal?.aborted === true;
  if (isCallerAborted()) {
    throw error("Image URL request was cancelled.");
  }
  const transport = options.transport ?? nodePinnedTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);

  let hops = 0;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    throw error("Image URL is invalid.");
  }

  try {
    for (;;) {
      const pinned = await assertSafeOutboundUrl(
        target,
        options.lookup,
        controller.signal,
      );
      const response = await transport({
        url: target,
        address: pinned.address,
        family: pinned.family,
        signal: controller.signal,
      });
      if (isRedirect(response.status)) {
        void response.body?.cancel().catch(() => undefined);
        hops += 1;
        if (hops > MAX_IMAGE_REDIRECT_HOPS) {
          throw error("Image URL redirects exceeded the allowed hop budget.");
        }
        const location = response.headers.get("location");
        if (location === null || location.length === 0) {
          throw error("Image URL redirect is missing a Location header.");
        }
        try {
          target = new URL(location, target);
        } catch {
          throw error("Image URL redirect location is invalid.");
        }
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw error(`Could not fetch image URL (${response.status}).`);
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > MAX_ANTIGRAVITY_IMAGE_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw error(`Image exceeds the ${MAX_ANTIGRAVITY_IMAGE_BYTES} byte limit.`);
      }
      return await readBodyLimited(response, MAX_ANTIGRAVITY_IMAGE_BYTES);
    }
  } catch (cause) {
    if (cause instanceof HttpError) {
      throw cause;
    }
    if (isCallerAborted()) {
      throw error("Image URL request was cancelled.");
    }
    if (controller.signal.aborted) {
      throw error(`Image URL request timed out after ${timeoutMs}ms.`);
    }
    throw error("Image URL request failed.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
