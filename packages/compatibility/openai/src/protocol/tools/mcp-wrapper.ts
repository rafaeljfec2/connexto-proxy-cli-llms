import type {
  OpenAiToolSpec,
  ToolCallContext,
  ToolParameterSchemaShape,
} from "../types.js";
import { isRecord } from "../common.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import { firstMatchingProperty, firstArg, firstStringArg } from "./candidates.js";
import {
  toolParameterSchema,
  toolParameterSchemaFromValue,
  wrapperObjectPropertyCandidates,
} from "./schema.js";

export interface McpWrapperNormalizerDeps {
  normalizeToolArguments: (
    args: Record<string, unknown>,
    tool: OpenAiToolSpec | undefined,
    emittedName?: string,
    wrapperDepth?: number,
    context?: ToolCallContext,
  ) => Record<string, unknown>;
}

let mcpDeps: McpWrapperNormalizerDeps | undefined;

export function setMcpWrapperNormalizerDeps(deps: McpWrapperNormalizerDeps): void {
  mcpDeps = deps;
}

export function resolveSpecificMCPTool(
  args: Record<string, unknown>,
  tools: OpenAiToolSpec[],
): OpenAiToolSpec | undefined {
  const normalizedCandidates = new Set(
    mcpToolNameCandidates(args).map(normalizeToolName),
  );
  if (!normalizedCandidates.size) return undefined;
  return tools.find((tool) => {
    const normalizedTool = normalizeToolName(tool.name);
    if (normalizedCandidates.has(normalizedTool)) return true;
    return Array.from(normalizedCandidates).some((candidate) =>
      normalizedTool.endsWith(candidate),
    );
  });
}

export function mcpToolNameCandidates(args: Record<string, unknown>): string[] {
  const provider = firstStringArg(
    args,
    "providerIdentifier",
    "provider_identifier",
    "provider",
    "server",
    "serverName",
    "server_name",
  );
  const toolName = firstStringArg(args, "toolName", "tool_name", "tool", "name");
  const candidates: string[] = [];
  if (toolName) candidates.push(toolName);
  if (toolName) {
    for (const providerName of mcpProviderNameVariants(provider)) {
      candidates.push(
        `${providerName}__${toolName}`,
        `${providerName}_${toolName}`,
        `mcp__${providerName}__${toolName}`,
        `mcp_${providerName}_${toolName}`,
      );
    }
  }
  return candidates;
}

export function mcpProviderNameVariants(provider: string | undefined): string[] {
  if (!provider?.trim()) return [];
  const variants: string[] = [];
  const append = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !variants.includes(trimmed)) variants.push(trimmed);
  };
  append(provider);
  for (const separator of [":", "/", "\\", "."]) {
    append(provider.split(separator).filter(Boolean).pop());
  }
  for (const prefix of ["mcp__", "mcp_", "mcp-", "mcp:"]) {
    if (provider.toLowerCase().startsWith(prefix))
      append(provider.slice(prefix.length));
  }
  return variants;
}

export function normalizeMCPWrapperArguments(
  args: Record<string, unknown>,
  schema: ToolParameterSchemaShape,
): Record<string, unknown> {
  if (!schema.properties.length) return args;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  const serverKey = firstMatchingProperty(
    ["serverName", "server", "provider", "providerIdentifier", "provider_identifier"],
    schema.properties,
    normalizedProperties,
  );
  const toolKey = firstMatchingProperty(
    ["toolName", "tool", "name", "tool_name"],
    schema.properties,
    normalizedProperties,
  );
  const argsKey = firstMatchingProperty(
    ["arguments", "args", "input", "params", "parameters"],
    schema.properties,
    normalizedProperties,
  );
  const serverName = firstStringArg(
    args,
    "providerIdentifier",
    "provider_identifier",
    "provider",
    "server",
    "serverName",
    "server_name",
  );
  const toolName = firstStringArg(args, "toolName", "tool_name", "tool", "name");
  const payload = mcpPayloadArguments(args);
  if (serverKey && serverName) output[serverKey] = serverName;
  if (toolKey && toolName) output[toolKey] = toolName;
  if (argsKey) output[argsKey] = payload;
  return Object.keys(output).length ? output : args;
}

export function mcpPayloadArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return recordArgumentValue(firstArg(args, mcpPayloadCandidates())) ?? {};
}

export function mcpPayloadCandidates(): string[] {
  return ["args", "arguments", "input", "params", "parameters", "payload", "data"];
}

export function normalizeWrapperObjectArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  emittedName: string,
  schema: ToolParameterSchemaShape,
  wrapperDepth: number,
  context?: ToolCallContext,
): Record<string, unknown> | undefined {
  if (!tool || wrapperDepth > 1 || !mcpDeps) return undefined;
  const wrapper = wrapperObjectArgumentProperty(tool, schema);
  if (!wrapper) return undefined;
  const nested = mcpDeps.normalizeToolArguments(
    args,
    { name: tool.name, description: tool.description, parameters: wrapper.parameters },
    canonicalToolName(emittedName) === "mcp" && canonicalToolName(tool.name) !== "mcp"
      ? tool.name
      : emittedName,
    wrapperDepth + 1,
    context,
  );
  return { [wrapper.key]: nested };
}

export function wrapperObjectArgumentProperty(
  tool: OpenAiToolSpec | undefined,
  schema = toolParameterSchema(tool),
): { key: string; parameters: unknown } | undefined {
  if (!tool || !schema.properties.length) return undefined;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  for (const candidate of wrapperObjectPropertyCandidates()) {
    const key = firstMatchingProperty(
      [candidate],
      schema.properties,
      normalizedProperties,
    );
    if (!key) continue;
    const parameters = schema.propertySchemas[key];
    if (toolParameterSchemaFromValue(parameters).properties.length > 0) {
      return { key, parameters };
    }
  }
  return undefined;
}

export function expandToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const normalized = normalizeToolName(key);
    const nested = recordArgumentValue(value);
    if (
      nested &&
      ["arguments", "args", "input", "parameters", "params"].includes(normalized)
    ) {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    if (nested && normalized === "targeting") {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function recordArgumentValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
