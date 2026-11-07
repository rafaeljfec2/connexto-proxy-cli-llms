import type { StorageState } from "./types.js";

const RELEVANT_COOKIE_DOMAIN =
  /(?:^|\.)(cursor\.com|grok\.com|authenticator\.cursor\.sh)$/i;

export function isUsableStorageState(
  state: StorageState | undefined,
): state is StorageState {
  if (state === undefined) {
    return false;
  }
  const cookies = state.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return false;
  }
  return cookies.some((cookie) =>
    RELEVANT_COOKIE_DOMAIN.test(cookie.domain ?? ""),
  );
}
