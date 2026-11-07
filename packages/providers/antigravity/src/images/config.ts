import type { PinnedTransport } from "./transport.js";

export const MAX_ANTIGRAVITY_IMAGE_BYTES = 1024 * 1024;
export const MAX_ANTIGRAVITY_IMAGES_PER_REQUEST = 8;
export const MAX_IMAGE_REDIRECT_HOPS = 3;
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** MIME types proven through real `agy` inference (PNG verified; JPEG fixture-backed). */
export const ALLOWED_ANTIGRAVITY_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
];

export interface SafeDnsRecord {
  readonly address: string;
  readonly family: number;
}

export type SafeLookupFn = (hostname: string) => Promise<readonly SafeDnsRecord[]>;

export interface ResolveAgentImagesOptions {
  readonly transport?: PinnedTransport;
  readonly lookup?: SafeLookupFn;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
