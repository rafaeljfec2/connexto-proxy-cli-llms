import { isIP } from "node:net";

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalizedHost === "localhost" || normalizedHost === "::1") return true;

  if (isIP(normalizedHost) === 4) {
    return normalizedHost.split(".")[0] === "127";
  }

  if (normalizedHost.startsWith("::ffff:")) {
    const mappedIpv4 = normalizedHost.slice("::ffff:".length);
    return isIP(mappedIpv4) === 4 && mappedIpv4.split(".")[0] === "127";
  }

  return false;
}
