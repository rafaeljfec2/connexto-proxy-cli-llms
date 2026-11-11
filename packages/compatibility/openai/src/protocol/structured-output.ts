import { HttpError } from "../http.js";
import { isRecord } from "./common.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/**
 * Unwraps a single outer Markdown code fence (```json ... ``` or ``` ... ```)
 * only when the entire trimmed response is a single fenced block.
 */
export function unwrapMarkdownJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const multilineMatch = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(
    trimmed,
  );
  if (multilineMatch) {
    return multilineMatch[1].trim();
  }

  const inlineMatch = /^```(?:json)?[ \t]*([\s\S]*?)[ \t]*```$/i.exec(trimmed);
  if (inlineMatch && !inlineMatch[1].includes("```")) {
    return inlineMatch[1].trim();
  }

  return trimmed;
}

function matchesPrimitiveType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | null {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type)
      ? schema.type.filter((item): item is string => typeof item === "string")
      : typeof schema.type === "string"
        ? [schema.type]
        : [];
    if (
      allowed.length > 0 &&
      !allowed.some((item) => matchesPrimitiveType(value, item))
    ) {
      return `${path} must match type ${allowed.join("|")}`;
    }
  }

  if ("const" in schema && !Object.is(value, schema.const)) {
    return `${path} must equal const value`;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => Object.is(value, item))
  ) {
    return `${path} must be one of enum values`;
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (isPlainObject(sub)) {
        const err = validateAgainstSchema(value, sub, path);
        if (err !== null) return err;
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const subs = schema.anyOf.filter(isPlainObject);
    if (
      subs.length > 0 &&
      !subs.some((sub) => validateAgainstSchema(value, sub, path) === null)
    ) {
      return `${path} does not match anyOf schemas`;
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey === "string" && !Object.hasOwn(value, reqKey)) {
          return `${path}.${reqKey} is required`;
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) {
          return `${path}.${key} is not allowed`;
        }
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.hasOwn(value, key) && isPlainObject(propSchema)) {
        const err = validateAgainstSchema(value[key], propSchema, `${path}.${key}`);
        if (err !== null) return err;
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const itemSchema = schema.items;
    for (let i = 0; i < value.length; i += 1) {
      const err = validateAgainstSchema(value[i], itemSchema, `${path}[${i}]`);
      if (err !== null) return err;
    }
  }

  return null;
}

/**
 * Enforces non-streaming structured output compliance for OpenAI Responses
 * `text.format` (`json_object` and `json_schema`).
 */
export function enforceStructuredOutputFormat(text: string, format: unknown): string {
  if (!isPlainObject(format)) return text;
  if (format.type !== "json_object" && format.type !== "json_schema") {
    return text;
  }

  const candidate = unwrapMarkdownJsonFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new HttpError(
      "Upstream model output is not valid JSON for the requested structured format.",
      502,
      "upstream_invalid_structured_output",
    );
  }

  if (format.type === "json_object") {
    if (!isPlainObject(parsed)) {
      throw new HttpError(
        "Upstream model output must be a JSON object for json_object format.",
        502,
        "upstream_invalid_structured_output",
      );
    }
    return candidate;
  }

  const schema = isPlainObject(format.json_schema)
    ? format.json_schema.schema
    : format.schema;
  const strict =
    format.strict === true ||
    (isPlainObject(format.json_schema) && format.json_schema.strict === true);

  if (strict && isPlainObject(schema)) {
    const failure = validateAgainstSchema(parsed, schema, "$");
    if (failure !== null) {
      throw new HttpError(
        `Upstream model output violated strict JSON schema (${failure}).`,
        502,
        "upstream_invalid_structured_output",
      );
    }
  }

  return candidate;
}
