import net from "node:net";

export class InvalidTargetUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTargetUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

function isPrivateOrReservedIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "0.0.0.0" || ip === "::1" || ip === "::") {
    return true;
  }

  // IPv4 checks
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    const [b0, b1] = parts;
    if (b0 === undefined || b1 === undefined) {
      return true;
    }

    // Loopback 127.0.0.0/8
    if (b0 === 127) return true;
    // Current network 0.0.0.0/8
    if (b0 === 0) return true;
    // Link-local / Cloud metadata 169.254.0.0/16
    if (b0 === 169 && b1 === 254) return true;
    // Private 10.0.0.0/8
    if (b0 === 10) return true;
    // Private 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // Private 192.168.0.0/16
    if (b0 === 192 && b1 === 168) return true;
    // CGNAT 100.64.0.0/10
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // Broadcast
    if (b0 === 255) return true;
  }

  // IPv6 checks
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // Unique local fc00::/7
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // Link-local fe80::/10
    if (lower.startsWith("fe80")) return true;
    // IPv4-mapped IPv6 ::ffff:127.0.0.1
    if (lower.includes("::ffff:")) {
      const v4Part = lower.split("::ffff:")[1];
      if (v4Part && isPrivateOrReservedIp(v4Part)) return true;
    }
  }

  return false;
}

export function validateTargetUrl(rawUrl: string): { valid: true; parsedUrl: URL } {
  if (rawUrl === "about:blank" || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
    return { valid: true, parsedUrl: new URL("about:blank") };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidTargetUrlError(`Invalid URL format: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidTargetUrlError(
      `Protocol '${parsed.protocol}' is not allowed. Only HTTP and HTTPS are supported.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new InvalidTargetUrlError(
      `Access to internal or loopback host '${hostname}' is prohibited (SSRF protection).`,
    );
  }

  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new InvalidTargetUrlError(
      `Access to private/reserved IP address '${hostname}' is prohibited (SSRF protection).`,
    );
  }

  return { valid: true, parsedUrl: parsed };
}

