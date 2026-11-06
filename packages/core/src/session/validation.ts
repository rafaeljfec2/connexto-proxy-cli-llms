import { InvalidSessionKeyError } from "./errors.js";

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateNamespace(namespace: string): void {
  if (typeof namespace !== "string" || !SAFE_IDENTIFIER_REGEX.test(namespace)) {
    throw new InvalidSessionKeyError(String(namespace), "namespace");
  }
}

export function validateKey(key: string): void {
  if (typeof key !== "string" || !SAFE_IDENTIFIER_REGEX.test(key)) {
    throw new InvalidSessionKeyError(String(key), "key");
  }
}

export function validateNamespaceAndKey(namespace: string, key: string): void {
  validateNamespace(namespace);
  validateKey(key);
}
