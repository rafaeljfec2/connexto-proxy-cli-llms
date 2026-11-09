export function sanitizeMcpToolSchema(parameters: unknown): Record<string, unknown> {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  const record = parameters as Record<string, unknown>;
  const type = typeof record["type"] === "string" ? record["type"] : "object";
  const properties =
    typeof record["properties"] === "object" &&
    record["properties"] !== null &&
    !Array.isArray(record["properties"])
      ? record["properties"]
      : {};
  const required = Array.isArray(record["required"])
    ? record["required"].filter((item): item is string => typeof item === "string")
    : [];

  const result: Record<string, unknown> = {
    type,
    properties,
  };
  if (required.length > 0) {
    result["required"] = required;
  }
  if (typeof record["additionalProperties"] === "boolean") {
    result["additionalProperties"] = record["additionalProperties"];
  }
  return result;
}

