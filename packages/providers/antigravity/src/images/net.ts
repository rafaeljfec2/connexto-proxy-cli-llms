/**
 * Forbidden-network detection for outbound image fetches (SSRF protection).
 *
 * The checks cover IPv4/IPv6 literal addresses, IPv4-mapped, IPv4-compatible,
 * 6to4 and Teredo transition addresses. They are shared by the URL literal
 * check and by the DNS resolution gate.
 */

const FORBIDDEN_IPV4_RANGES: ReadonlyArray<{
  readonly lo: number;
  readonly hi: number;
  readonly label: string;
}> = [
  { lo: 0x00000000, hi: 0x00ffffff, label: "this-network (0.0.0.0/8)" },
  { lo: 0x0a000000, hi: 0x0affffff, label: "private (10/8)" },
  { lo: 0x64400000, hi: 0x647fffff, label: "shared (100.64/10)" },
  { lo: 0x7f000000, hi: 0x7fffffff, label: "loopback (127/8)" },
  { lo: 0xa9000000, hi: 0xa9ffffff, label: "link-local (169.254/16)" },
  { lo: 0xac100000, hi: 0xac1fffff, label: "private (172.16/12)" },
  { lo: 0xc0000000, hi: 0xc00000ff, label: "IETF protocol assignments (192.0.0/24)" },
  { lo: 0xc0000200, hi: 0xc00002ff, label: "documentation (192.0.2/24)" },
  { lo: 0xc0006400, hi: 0xc00065ff, label: "documentation (198.51.100/24)" },
  { lo: 0xc0a80000, hi: 0xc0a8ffff, label: "private (192.168/16)" },
  { lo: 0xc6120000, hi: 0xc613ffff, label: "benchmarking (198.18/15)" },
  { lo: 0xcb007100, hi: 0xcb0071ff, label: "documentation (203.0.113/24)" },
  { lo: 0xe0000000, hi: 0xefffffff, label: "multicast (224/4)" },
  { lo: 0xf0000000, hi: 0xffffffff, label: "reserved (240/4)" },
];

function ipv4ToUint32(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function forbiddenIpv4(address: string): string | undefined {
  if (address === "localhost") return "loopback hostname";
  const value = ipv4ToUint32(address);
  if (value === undefined) return undefined;
  for (const range of FORBIDDEN_IPV4_RANGES) {
    if (value >= range.lo && value <= range.hi) return range.label;
  }
  return undefined;
}

/** Expands a canonical textual IPv6 address into eight 16-bit groups. */
function expandIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (section: string): number[] | undefined => {
    if (section === "") return [];
    const groups: number[] = [];
    for (const group of section.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = parseGroups(halves[0]);
    if (groups === undefined || groups.length !== 8) return undefined;
    return groups;
  }
  const head = parseGroups(halves[0]);
  const tail = parseGroups(halves[1]);
  if (head === undefined || tail === undefined) return undefined;
  if (head.length + tail.length > 7) return undefined;
  return [
    ...head,
    ...Array.from({ length: 8 - head.length - tail.length }, () => 0),
    ...tail,
  ];
}

/** Returns the reason an address is forbidden, or undefined when allowed. */
export function isForbiddenInetAddress(address: string): string | undefined {
  const normalized = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!normalized.includes(":")) {
    return forbiddenIpv4(normalized);
  }

  const groups = expandIpv6(normalized);
  if (groups === undefined) return "unparseable IPv6 address";

  if (groups.every((group) => group === 0)) return "unspecified address (::)";
  if (groups[5] === 0xffff && groups.slice(0, 5).every((group) => group === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) — embedded IPv4 decides alone.
    return forbiddenIpv4(groupsToDotted((groups[6] << 16) + groups[7]));
  }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return "IPv6 loopback (::1)";
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    // IPv4-compatible (::a.b.c.d) is deprecated and blocked outright (fail closed).
    return "IPv4-compatible IPv6 (::/96)";
  }
  if (
    groups.slice(0, 4).every((group) => group === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  ) {
    // SIIT translated addresses (::ffff:0:a.b.c.d) — embedded IPv4 decides alone.
    return forbiddenIpv4(groupsToDotted((groups[6] << 16) + groups[7]));
  }

  const firstGroup = groups[0];
  const firstByte = firstGroup >> 8;
  const secondByte = firstGroup & 0xff;
  if (firstByte === 0xfc || firstByte === 0xfd) return "ULA (fc00::/7)";
  if (firstByte === 0xfe && secondByte >> 6 === 2) {
    return "link-local (fe80::/10)";
  }
  if (firstByte === 0xfe && secondByte >> 6 === 3) {
    return "site-local (fec0::/10)";
  }
  if (firstByte === 0xff) return "multicast (ff00::/8)";

  if (firstGroup === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) {
    return "discard-only (100::/64)";
  }
  if (firstGroup === 0x2001 && groups[1] === 0x0db8) {
    return "documentation (2001:db8::/32)";
  }
  if (firstGroup === 0x2001 && groups[1] === 0x0000) {
    return "Teredo transition address (2001::/32)";
  }
  if (firstGroup === 0x2002) {
    // 6to4 embeds the IPv4 endpoint in the second and third groups.
    return forbiddenIpv4(groupsToDotted((groups[1] << 16) + groups[2]));
  }
  if (firstGroup === 0x64 && groups[1] === 0xff9b) {
    if (groups[2] === 0x0001) return "local-use NAT64 (64:ff9b:1::/48)";
    return "NAT64 transition address (64:ff9b::/96)";
  }
  return undefined;
}

function groupsToDotted(value: number): string {
  const unsigned = value >>> 0;
  return `${unsigned >>> 24}.${(unsigned >>> 16) & 0xff}.${(unsigned >>> 8) & 0xff}.${unsigned & 0xff}`;
}
