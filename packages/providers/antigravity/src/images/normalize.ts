import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import type { CursorImage } from "@agent-runtime-gateway/compatibility-openai";
import type { AgentImageInput } from "@agent-runtime-gateway/core";
import dns from "node:dns";
import {
  ALLOWED_ANTIGRAVITY_IMAGE_MIME_TYPES,
  MAX_ANTIGRAVITY_IMAGE_BYTES,
  MAX_ANTIGRAVITY_IMAGES_PER_REQUEST,
  type ResolveAgentImagesOptions,
} from "./config.js";
import { fetchSafeImageBytes } from "./fetch.js";
import type { SafeLookupFn } from "./config.js";
import { sniffImageMime } from "./sniff.js";

/** Upper bound on base64 characters that can decode to at most the byte limit. */
const MAX_BASE64_CHARS = Math.ceil(MAX_ANTIGRAVITY_IMAGE_BYTES / 3) * 4;

const defaultLookup: SafeLookupFn = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

function error(message: string, param: string): HttpError {
  return new HttpError(message, 400, "invalid_request_error", param);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function resolveDataImage(
  image: Extract<CursorImage, { data: string }>,
): AgentImageInput {
  if (
    image.mimeType === undefined ||
    !ALLOWED_ANTIGRAVITY_IMAGE_MIME_TYPES.includes(image.mimeType.toLowerCase())
  ) {
    throw error(
      "Image is not a supported Antigravity MIME type (PNG or JPEG).",
      "image_url",
    );
  }

  if (image.data.length > MAX_BASE64_CHARS * 2) {
    throw error(
      `Image exceeds the ${MAX_ANTIGRAVITY_IMAGE_BYTES} byte limit.`,
      "image_url",
    );
  }
  const normalized = image.data.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw error("Image data is not valid base64.", "image_url");
  }

  if (normalized.length > MAX_BASE64_CHARS) {
    throw error(
      `Image exceeds the ${MAX_ANTIGRAVITY_IMAGE_BYTES} byte limit.`,
      "image_url",
    );
  }

  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) {
    throw error("Image data is empty.", "image_url");
  }
  if (bytes.length > MAX_ANTIGRAVITY_IMAGE_BYTES) {
    throw error(
      `Image exceeds the ${MAX_ANTIGRAVITY_IMAGE_BYTES} byte limit.`,
      "image_url",
    );
  }

  const sniffed = sniffImageMime(bytes);
  if (sniffed === undefined) {
    throw error("Image bytes are not a supported image (PNG or JPEG).", "image_url");
  }
  return { mimeType: sniffed, data: toBase64(bytes) };
}

async function resolveUrlImage(
  url: string,
  options: ResolveAgentImagesOptions,
): Promise<AgentImageInput> {
  const bytes = await fetchSafeImageBytes(url, {
    transport: options.transport,
    lookup: options.lookup ?? defaultLookup,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  const sniffed = sniffImageMime(bytes);
  if (sniffed === undefined) {
    throw error(
      "Image URL payload is not a supported image (PNG or JPEG).",
      "image_url",
    );
  }
  return { mimeType: sniffed, data: toBase64(bytes) };
}

/**
 * Converts OpenAI/compatibility image descriptors into neutral ACP-ready
 * image inputs, preserving declared order and re-sniffing every payload with
 * SSRF-safe fetching for URL inputs.
 */
export async function resolveAgentImages(
  images: readonly CursorImage[],
  options: ResolveAgentImagesOptions = {},
): Promise<AgentImageInput[]> {
  if (images.length > MAX_ANTIGRAVITY_IMAGES_PER_REQUEST) {
    throw error(
      `At most ${MAX_ANTIGRAVITY_IMAGES_PER_REQUEST} images can be sent per request.`,
      "images",
    );
  }

  const resolved: AgentImageInput[] = [];
  for (const image of images) {
    if ("data" in image) {
      resolved.push(resolveDataImage(image));
    } else if ("url" in image) {
      resolved.push(await resolveUrlImage(image.url, options));
    } else {
      throw error("Image input has no data or URL.", "image_url");
    }
  }
  return resolved;
}
