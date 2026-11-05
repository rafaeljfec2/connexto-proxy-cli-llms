import { HttpError } from "../http.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new HttpError(
      `${name} must be an object`,
      400,
      "invalid_request_error",
      name,
    );
  return value;
}

export function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    throw new HttpError(`${name} must be an array`, 400, "invalid_request_error", name);
  return value;
}

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

export function includeStreamUsage(record: Record<string, unknown>): boolean {
  return (
    isRecord(record.stream_options) && record.stream_options.include_usage === true
  );
}

export function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
