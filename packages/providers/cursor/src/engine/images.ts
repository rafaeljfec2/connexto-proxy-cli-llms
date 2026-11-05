import {
  HttpError,
  type CursorImage,
} from "@agent-runtime-gateway/compatibility-openai";
import type { CursorDeps, EncodedCursorImage } from "./types.js";
import { protoField, protoMessage } from "./connect-proto.js";

export const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;

export async function resolveCursorImages(
  images: CursorImage[],
  deps: CursorDeps,
): Promise<EncodedCursorImage[]> {
  const encoded: EncodedCursorImage[] = [];
  for (const [index, image] of images.entries()) {
    const data =
      "data" in image
        ? decodeBase64(image.data)
        : await fetchImageBytes(image.url, deps);
    if (!data.length)
      throw new HttpError(
        "Image input is empty.",
        400,
        "invalid_request_error",
        "image",
      );
    if (data.length > MAX_CURSOR_IMAGE_BYTES) {
      throw new HttpError(
        "Image input is too large. Resize images to 1024px or less and keep each image under 1MB.",
        400,
        "invalid_request_error",
        "image",
      );
    }
    encoded.push({
      data,
      uuid: image.uuid ?? stableImageId(index),
      ...("dimension" in image && image.dimension
        ? { dimension: image.dimension }
        : {}),
    });
  }
  return encoded;
}

export async function fetchImageBytes(
  url: string,
  deps: CursorDeps,
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(
      "Image URL is invalid.",
      400,
      "invalid_request_error",
      "image_url",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(
      "Image URL must use http or https.",
      400,
      "invalid_request_error",
      "image_url",
    );
  }
  const response = await deps.fetch(parsed.toString(), { method: "GET" });
  if (!response.ok) {
    throw new HttpError(
      `Could not fetch image URL (${response.status}).`,
      400,
      "invalid_request_error",
      "image_url",
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new HttpError(
      "Image URL did not return an image content type.",
      400,
      "invalid_request_error",
      "image_url",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function encodeImageProto(image: EncodedCursorImage): Uint8Array {
  const fields = [protoField(1, 2, image.data)];
  if (image.dimension) {
    fields.push(
      protoField(
        2,
        2,
        protoMessage([
          protoField(1, 0, image.dimension.width),
          protoField(2, 0, image.dimension.height),
        ]),
      ),
    );
  }
  fields.push(protoField(3, 2, image.uuid));
  return protoMessage(fields);
}

export function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "");
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new HttpError(
      "Image data URL contains invalid base64 data.",
      400,
      "invalid_request_error",
      "image_url",
    );
  }
}

export function stableImageId(index: number): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `image-${Date.now()}-${index}`;
}
