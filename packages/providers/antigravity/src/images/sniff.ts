/** Detects the real image MIME type from the payload magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}
