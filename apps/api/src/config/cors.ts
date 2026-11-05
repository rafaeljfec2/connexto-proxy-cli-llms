const corsOriginsError =
  "CORS_ORIGINS must contain valid HTTP(S) origins without wildcards";
const originPattern = /^https?:\/\/([^/?#]+)\/?$/i;

export function parseCorsOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return [];

  const entries = value.split(",").map((origin) => origin.trim());
  if (entries.some((origin) => origin.length === 0)) {
    throw new Error(corsOriginsError);
  }

  return [...new Set(entries.map(normalizeCorsOrigin))];
}

function normalizeCorsOrigin(value: string): string {
  const authority = originPattern.exec(value)?.[1];
  if (
    value.includes("*") ||
    /\s/.test(value) ||
    authority === undefined ||
    authority.endsWith(":")
  ) {
    throw new Error(corsOriginsError);
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(value);
  } catch {
    throw new Error(corsOriginsError);
  }

  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    parsedOrigin.origin === "null" ||
    parsedOrigin.username.length > 0 ||
    parsedOrigin.password.length > 0 ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search.length > 0 ||
    parsedOrigin.hash.length > 0
  ) {
    throw new Error(corsOriginsError);
  }

  return parsedOrigin.origin;
}
