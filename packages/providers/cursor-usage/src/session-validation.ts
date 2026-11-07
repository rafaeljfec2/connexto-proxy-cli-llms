import type { CursorUsageSessionRecord, StorageState } from "./types.js";

const RELEVANT_COOKIE_DOMAIN =
  /(?:^|\.)(cursor\.com|cursor\.sh|grok\.com|authenticator\.cursor\.sh|workos\.com)$/i;

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

export function isCollectableSessionRecord(
  record: Pick<CursorUsageSessionRecord, "storageState" | "authProfileBacked">,
  authProfilePresent: boolean,
): boolean {
  if (isUsableStorageState(record.storageState)) {
    return true;
  }
  if (record.authProfileBacked === true) {
    return true;
  }
  return authProfilePresent;
}
