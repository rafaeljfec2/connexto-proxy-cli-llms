import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import { describe, expect, it } from "vitest";
import {
  MAX_ANTIGRAVITY_IMAGE_BYTES,
  MAX_ANTIGRAVITY_IMAGES_PER_REQUEST,
  resolveAgentImages,
} from "../src/images/index.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0xff, 0xd9,
]);
const JPEG_BASE64 = Buffer.from(JPEG_BYTES).toString("base64");

const GIF_BYTES = Buffer.from("GIF89a01020304", "ascii");
const GIF_BASE64 = GIF_BYTES.toString("base64");

const TEXT_BYTES = Buffer.from("<html><body>not an image</body></html>", "ascii");
const TEXT_BASE64 = TEXT_BYTES.toString("base64");

function pngImageInput() {
  return { data: PNG_1X1_BASE64, mimeType: "image/png" };
}

describe("resolveAgentImages", () => {
  it("resolves a PNG data URL to a neutral PNG image input", async () => {
    const images = await resolveAgentImages([pngImageInput()]);

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ mimeType: "image/png", data: PNG_1X1_BASE64 });
  });

  it("resolves a JPEG data URL and sniffed JPEG magic bytes", async () => {
    const images = await resolveAgentImages([
      { data: JPEG_BASE64, mimeType: "image/jpeg" },
    ]);

    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      mimeType: "image/jpeg",
      data: JPEG_BASE64,
    });
  });

  it("accepts raw base64 data with a declared PNG mimeType", async () => {
    const images = await resolveAgentImages([
      { data: PNG_1X1_BASE64, mimeType: "image/png" },
    ]);

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("resolves multiple images preserving the input order", async () => {
    const images = await resolveAgentImages([
      pngImageInput(),
      { data: JPEG_BASE64, mimeType: "image/jpeg" },
      pngImageInput(),
    ]);

    expect(images).toHaveLength(3);
    expect(images.map((image) => image.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/png",
    ]);
  });

  it("rejects unsupported declared MIME types", async () => {
    await expect(
      resolveAgentImages([{ data: GIF_BASE64, mimeType: "image/gif" }]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects payloads whose sniffed magic bytes are not an allowed image", async () => {
    await expect(
      resolveAgentImages([{ data: GIF_BASE64, mimeType: "image/png" }]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects non-image payloads", async () => {
    await expect(
      resolveAgentImages([{ data: TEXT_BASE64, mimeType: "image/png" }]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects invalid base64 payloads", async () => {
    await expect(
      resolveAgentImages([{ data: "QUJD***", mimeType: "image/png" }]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects empty payloads", async () => {
    await expect(
      resolveAgentImages([{ data: "", mimeType: "image/png" }]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects payloads above the configured byte limit", async () => {
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024 * 1024, 0x42),
    ]);

    await expect(
      resolveAgentImages([
        { data: oversized.toString("base64"), mimeType: "image/png" },
      ]),
    ).rejects.toThrow(HttpError);
  });

  it("rejects requests with too many images", async () => {
    const tooMany = Array.from(
      { length: MAX_ANTIGRAVITY_IMAGES_PER_REQUEST + 1 },
      () => ({
        data: PNG_1X1_BASE64,
        mimeType: "image/png",
      }),
    );

    await expect(resolveAgentImages(tooMany)).rejects.toThrow(HttpError);
  });

  it("accepts a payload of exactly the byte limit", async () => {
    const exact = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_ANTIGRAVITY_IMAGE_BYTES - 8, 0x42),
    ]);

    const images = await resolveAgentImages([
      { data: exact.toString("base64"), mimeType: "image/png" },
    ]);

    expect(images).toHaveLength(1);
  });

  it("accepts exactly the maximum number of images", async () => {
    const maxImages = Array.from(
      { length: MAX_ANTIGRAVITY_IMAGES_PER_REQUEST },
      () => ({ data: PNG_1X1_BASE64, mimeType: "image/png" }),
    );

    const images = await resolveAgentImages(maxImages);

    expect(images).toHaveLength(MAX_ANTIGRAVITY_IMAGES_PER_REQUEST);
  });
});
