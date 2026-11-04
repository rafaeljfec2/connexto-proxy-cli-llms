import type { ProviderCredential } from "@agent-runtime-gateway/core";
import { ConfigurationError } from "@cursor/sdk";

const CURSOR_CREDENTIAL_TYPES = new Set(["cursor_api_key", "api_key"]);

export function resolveCursorApiKey(
  credential: ProviderCredential,
  label = "Cursor API key",
): string {
  if (!CURSOR_CREDENTIAL_TYPES.has(credential.type)) {
    throw new ConfigurationError(
      `Unsupported credential type "${credential.type}" for Cursor provider`,
    );
  }

  const value = credential.value.trim();
  if (value.length === 0) {
    throw new ConfigurationError(`${label} is empty`);
  }

  return value;
}

export function resolveOptionalCursorApiKey(
  credential: ProviderCredential | undefined,
): string | undefined {
  if (credential === undefined) {
    return undefined;
  }

  try {
    return resolveCursorApiKey(credential);
  } catch {
    return undefined;
  }
}
