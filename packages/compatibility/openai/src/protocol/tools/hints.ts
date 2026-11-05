import type { CursorToolCall } from "../../types.js";
import type { OpenAiToolSpec, ToolCallContext } from "../types.js";
import { isRecord } from "../common.js";
import { firstMatchingProperty } from "./aliases.js";
import {
  canonicalToolName,
  isKnownMappedToolName,
  normalizeToolName,
  mcpTargetForClientToolName,
} from "./specs.js";
import {
  schemaJsonTypes,
  toolArgumentsSatisfySchema,
  toolParameterSchema,
} from "./schema.js";

// Import dynamically or as type to prevent circular reference, resolveToolSpec and normalizeToolArguments are passed or imported
import {
  normalizeSdkToolCall,
  normalizeToolArguments,
  resolveToolSpec,
} from "./resolution.js";

export function toolCallRetryHint(input: {
  toolCall: CursorToolCall;
  tools?: OpenAiToolSpec[];
  context?: ToolCallContext;
}): string {
  const tools = input.tools ?? [];
  const normalizedToolCall = normalizeSdkToolCall(input.toolCall);
  const args = normalizedToolCall.arguments ?? {};
  const tool = resolveToolSpec(normalizedToolCall.name, args, tools);
  if (!tool) {
    if (!tools.length)
      return `No client tool inventory was available for SDK ${normalizedToolCall.name}.`;
    return `SDK ${normalizedToolCall.name} did not match any client tool. Available client tools: ${tools.map((item) => item.name).join(", ")}.`;
  }
  const toolArguments = normalizeToolArguments(
    args,
    tool,
    normalizedToolCall.name,
    0,
    input.context,
  );
  if (toolArgumentsSatisfySchema(toolArguments, tool)) {
    return `SDK ${normalizedToolCall.name} maps to client ${tool.name}; retry with complete arguments for that route.`;
  }
  return [
    `SDK ${normalizedToolCall.name} mapped to client ${tool.name}, but normalized arguments do not satisfy the client JSON schema.`,
    `Normalized arguments: ${safeJsonForPrompt(toolArguments)}.`,
    `Required client arguments: ${toolRequiredArgumentSummary(tool)}.`,
    `Client schema properties: ${toolSchemaPropertySummary(tool)}.`,
  ].join(" ");
}

export function directToolChoiceHint(toolName: string): string {
  return `Use the ${toolName} tool if you call a tool.`;
}

export function requestedToolHint(toolName: string): string {
  if (
    canonicalToolName(toolName) === "glob" &&
    normalizeToolName(toolName) !== "glob"
  ) {
    return `Use SDK glob now; it will be forwarded to client tool ${toolName} with arguments matching its schema. Do not substitute shell or prose for this explicitly requested client tool.`;
  }
  const canonical = canonicalToolName(toolName);
  if (isKnownMappedToolName(toolName)) {
    return `Use SDK ${canonical} now; it will be forwarded to client tool ${toolName} with arguments matching its schema. Do not substitute a different tool.`;
  }
  const target = mcpTargetForClientToolName(toolName, { includeMapped: false });
  if (target) {
    return `Use SDK mcp now with providerIdentifier "${target.provider}", toolName "${target.toolName}", and args matching the ${toolName} schema. Do not use SDK shell/write as a substitute for this explicitly requested client tool.`;
  }
  return `Use SDK mcp now with providerIdentifier "client", toolName "${toolName}", and args matching the ${toolName} schema. Do not substitute a different tool.`;
}

export function explicitlyRequestedToolName(
  text: string,
  tools: OpenAiToolSpec[],
): string | undefined {
  const lower = text.toLowerCase();
  return [...tools]
    .sort((a, b) => b.name.length - a.name.length)
    .find((tool) => {
      const name = tool.name.trim();
      if (name.length <= 3) return false;
      const loweredName = name.toLowerCase();
      const normalized = normalizeToolName(name);
      if (
        lower.includes(`${loweredName} tool`) ||
        lower.includes(`tool ${loweredName}`) ||
        lower.includes(`tool named ${loweredName}`) ||
        lower.includes(`use ${loweredName}`)
      ) {
        return true;
      }
      return (
        (name.includes("_") || name.includes("-")) &&
        (lower.includes(loweredName) || lower.includes(normalized))
      );
    })?.name;
}

export function toolRequiredArgumentSummary(tool: OpenAiToolSpec): string {
  const schema = toolParameterSchema(tool);
  if (!schema.required.length) return "none";
  return schema.required
    .flatMap((property) => {
      const canonicalProperty =
        schema.properties.find(
          (item) => normalizeToolName(item) === normalizeToolName(property),
        ) ?? property;
      return requiredArgumentSummaryForSchema(
        canonicalProperty,
        schema.propertySchemas[canonicalProperty],
      );
    })
    .join(", ");
}

export function requiredArgumentSummaryForSchema(
  prefix: string,
  schema: unknown,
): string[] {
  if (!isRecord(schema)) return [`${prefix}:unknown`];
  const nestedProperties = isRecord(schema.properties) ? schema.properties : {};
  const nestedNames = Object.keys(nestedProperties);
  const nestedRequired = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  if (nestedNames.length && nestedRequired.length) {
    const normalizedProperties = new Map(
      nestedNames.map((property) => [normalizeToolName(property), property]),
    );
    return nestedRequired.flatMap((property) => {
      const canonicalProperty =
        firstMatchingProperty([property], nestedNames, normalizedProperties) ??
        property;
      return requiredArgumentSummaryForSchema(
        `${prefix}.${canonicalProperty}`,
        nestedProperties[canonicalProperty],
      );
    });
  }
  if (isRecord(schema.items)) {
    const itemSummaries = requiredArgumentSummaryForSchema(`${prefix}[]`, schema.items);
    if (itemSummaries.some((item) => item !== `${prefix}[]:unknown`))
      return itemSummaries;
  }
  return [`${prefix}:${schemaTypeLabel(schema)}`];
}

export function toolSchemaPropertySummary(tool: OpenAiToolSpec): string {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return "none";
  return schema.properties
    .map(
      (property) => `${property}:${schemaTypeLabel(schema.propertySchemas[property])}`,
    )
    .join(", ");
}

export function schemaTypeLabel(schema: unknown): string {
  if (!isRecord(schema)) return "unknown";
  const constValue = typeof schema.const === "string" ? `=${schema.const}` : "";
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((item): item is string => typeof item === "string")
    : [];
  if (enumValues.length) return `enum(${enumValues.join("|")})`;
  const types = schemaJsonTypes(schema);
  return `${types.join("|") || "any"}${constValue}`;
}

export function safeJsonForPrompt(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "null";
    return json.length > 700 ? `${json.slice(0, 700)}...` : json;
  } catch {
    return "[unserializable]";
  }
}
