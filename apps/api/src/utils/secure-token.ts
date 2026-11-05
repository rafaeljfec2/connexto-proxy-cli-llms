import { createHash, timingSafeEqual } from "node:crypto";

export function secureTokenEquals(candidate: string, expected: string): boolean {
  if (candidate.length === 0 || expected.length === 0) return false;

  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();

  return timingSafeEqual(candidateDigest, expectedDigest);
}
