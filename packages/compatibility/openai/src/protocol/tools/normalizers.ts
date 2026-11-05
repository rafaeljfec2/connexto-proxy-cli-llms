import type { OpenAiToolSpec, ToolCallContext } from "../types.js";
import { isRecord } from "../common.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import {
  firstMatchingProperty,
  firstStringArg,
  shellCommandCandidates,
  shellExplicitWorkdirCandidates,
  timeoutCandidates,
  globPatternCandidates,
  globPathCandidates,
  shouldIncludeOptionalPath,
  setGlobPathNormalizer,
} from "./candidates.js";
import { toolParameterSchema, toolPropertySchema } from "./schema.js";
import {
  strReplaceEditorArguments,
  commandStyleFileArguments,
  patchStyleFileArguments,
  listAsGlobArguments,
  globArguments,
  setFileToolNormalizerDeps,
} from "./file-tools.js";
import {
  isShellLikeTool,
  commandLikeProperty,
  commandLikeValue,
  isSyntheticSdkWorkingDirectory,
  shellDescription,
  shouldBackgroundShellCommand,
  backgroundShellCommand,
  shellFallbackArguments,
  setShellToolNormalizerDeps,
} from "./shell.js";
import {
  normalizeMCPWrapperArguments,
  normalizeWrapperObjectArguments,
  mcpPayloadArguments,
  expandToolArguments,
  setMcpWrapperNormalizerDeps,
} from "./mcp-wrapper.js";
import { toolSpecificArgumentAliases, commonArgumentAliases } from "./aliases.js";

// Wire circular normalizer dependencies
setFileToolNormalizerDeps({
  normalizeToolArgumentValue,
});

setShellToolNormalizerDeps({
  normalizeToolArgumentValue,
  applyRequiredToolDefaults,
  sanitizeNormalizedToolArguments,
});

setMcpWrapperNormalizerDeps({
  normalizeToolArguments,
});

setGlobPathNormalizer(absolutizeToolPath);

export function normalizeToolArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  emittedName = "",
  wrapperDepth = 0,
  context?: ToolCallContext,
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const emittedCanonical = canonicalToolName(emittedName);
  const selectedCanonical = canonicalToolName(tool?.name ?? "");
  const selectedTool = normalizeToolName(tool?.name ?? "");
  if (emittedCanonical === "mcp" && selectedCanonical === "mcp") {
    return normalizeMCPWrapperArguments(args, schema);
  }
  const argsToNormalize =
    emittedCanonical === "mcp"
      ? expandToolArguments(mcpPayloadArguments(args))
      : expandToolArguments(args);
  if (!schema.properties.length) return argsToNormalize;
  const wrapperObjectArguments = normalizeWrapperObjectArguments(
    argsToNormalize,
    tool,
    emittedName,
    schema,
    wrapperDepth,
    context,
  );
  if (wrapperObjectArguments) {
    return wrapperObjectArguments;
  }
  if (selectedTool === "strreplaceeditor") {
    return strReplaceEditorArguments(argsToNormalize, emittedCanonical, tool);
  }
  const commandStyleFile = commandStyleFileArguments(
    argsToNormalize,
    emittedCanonical,
    tool,
    context,
  );
  if (commandStyleFile) {
    return commandStyleFile;
  }
  const patchStyleFile = patchStyleFileArguments(
    argsToNormalize,
    emittedCanonical,
    tool,
    context,
  );
  if (patchStyleFile) {
    return patchStyleFile;
  }
  if (emittedCanonical !== "shell" && selectedCanonical === "shell") {
    return shellFallbackArguments(argsToNormalize, emittedName, tool);
  }
  if (emittedCanonical === "ls" && selectedCanonical === "glob") {
    return listAsGlobArguments(argsToNormalize, tool, context);
  }
  if (emittedCanonical === "glob" && selectedCanonical === "glob") {
    return globArguments(argsToNormalize, tool, context);
  }

  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  const priorities = new Map<string, number>();
  for (const [key, value] of Object.entries(argsToNormalize)) {
    const mapped = mapToolArgument(
      key,
      schema.properties,
      normalizedProperties,
      tool?.name,
    );
    if (!mapped) {
      if (schema.allowAdditionalProperties) output[key] = value;
      continue;
    }
    const previous = priorities.get(mapped.target) ?? -1;
    if (mapped.priority >= previous) {
      output[mapped.target] = normalizeToolArgumentValue(
        value,
        mapped.target,
        tool,
        context,
        key,
      );
      priorities.set(mapped.target, mapped.priority);
    }
  }
  return sanitizeNormalizedToolArguments(
    applyRequiredToolDefaults(output, schema.required, tool, argsToNormalize),
    tool,
    argsToNormalize,
  );
}

export function normalizeToolArgumentValue(
  value: unknown,
  targetProperty: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
  sourceProperty?: string,
): unknown {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    toolPropertyPrefersSecondsTimeout(tool, targetProperty)
  ) {
    return normalizeTimeoutForSecondsTool(value, sourceProperty);
  }
  if (typeof value !== "string") return value;
  if (!toolPropertyPrefersAbsolutePath(tool, targetProperty)) return value;
  return absolutizeToolPath(value, context);
}

export function normalizeTimeoutForSecondsTool(
  value: number,
  sourceProperty?: string,
): number {
  const source = normalizeToolName(sourceProperty ?? "");
  if (["timeoutseconds", "seconds"].includes(source)) return value;
  if (["timeoutms", "timeoutmilliseconds", "milliseconds"].includes(source))
    return Math.max(1, Math.ceil(value / 1000));
  return value >= 1000 ? Math.max(1, Math.ceil(value / 1000)) : value;
}

export function toolPropertyPrefersSecondsTimeout(
  tool: OpenAiToolSpec | undefined,
  property: string,
): boolean {
  const normalizedProperty = normalizeToolName(property);
  if (!["timeout", "timeoutseconds", "seconds"].includes(normalizedProperty))
    return false;
  if (["timeoutseconds", "seconds"].includes(normalizedProperty)) return true;
  const schema = toolPropertySchema(tool, property);
  const description =
    isRecord(schema) && typeof schema.description === "string"
      ? schema.description.toLowerCase()
      : "";
  return (
    /\bseconds?\b/.test(description) && !/\bmilliseconds?\b|\bms\b/.test(description)
  );
}

export function toolPropertyPrefersAbsolutePath(
  tool: OpenAiToolSpec | undefined,
  property: string,
): boolean {
  const schema = toolPropertySchema(tool, property);
  const description =
    isRecord(schema) && typeof schema.description === "string"
      ? schema.description.toLowerCase()
      : "";
  if (description.includes("absolute path")) return true;
  const normalizedProperty = normalizeToolName(property);
  const canonical = canonicalToolName(tool?.name ?? "");
  return (
    ["read", "write", "edit", "delete"].includes(canonical) &&
    ["filepath", "absolutepath"].includes(normalizedProperty)
  );
}

export function absolutizeToolPath(value: string, context?: ToolCallContext): string {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\$)/i.test(trimmed)) return trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const home = homeDirectoryFromContext(context);
    if (!home) return trimmed;
    return normalizePosixPath(trimmed === "~" ? home : `${home}/${trimmed.slice(2)}`);
  }
  if (trimmed.startsWith("/")) return normalizePosixPath(trimmed);
  const base = sanitizeContextPath(context?.workingDirectory);
  if (!base || !base.startsWith("/")) return trimmed;
  return normalizePosixPath(`${base.replace(/\/+$/, "")}/${trimmed}`);
}

export function homeDirectoryFromContext(
  context?: ToolCallContext,
): string | undefined {
  const base = sanitizeContextPath(context?.workingDirectory);
  if (!base?.startsWith("/")) return undefined;
  return /^\/Users\/[^/]+/.exec(base)?.[0] ?? /^\/home\/[^/]+/.exec(base)?.[0];
}

export function sanitizeContextPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^["']|["']$/g, "");
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  )
    return undefined;
  return trimmed;
}

export function normalizePosixPath(value: string): string {
  if (!value.startsWith("/")) return value.replace(/\/{2,}/g, "/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function applyRequiredToolDefaults(
  output: Record<string, unknown>,
  required: string[],
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>,
): Record<string, unknown> {
  if (!required.length) return output;
  const normalizedTool = normalizeToolName(tool?.name ?? "");
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const next = { ...output };
  if (isShellLikeTool(tool, originalArgs)) {
    const workdirKey = firstMatchingProperty(
      shellExplicitWorkdirCandidates(),
      schema.properties,
      normalizedProperties,
    );
    if (
      workdirKey &&
      required.includes(workdirKey) &&
      !shouldIncludeOptionalPath(next[workdirKey])
    ) {
      next[workdirKey] = ".";
    }
    const timeoutKey = firstMatchingProperty(
      timeoutCandidates(),
      schema.properties,
      normalizedProperties,
    );
    if (timeoutKey && required.includes(timeoutKey) && next[timeoutKey] === undefined) {
      next[timeoutKey] = normalizeToolArgumentValue(120_000, timeoutKey, tool);
    }
    if (required.includes("description") && typeof next.description !== "string") {
      const command =
        commandLikeValue(next, tool) ??
        firstStringArg(originalArgs, ...shellCommandCandidates());
      next.description = shellDescription(command);
    }
    const commandKey = commandLikeProperty(tool) ?? "command";
    if (required.includes(commandKey) && typeof next[commandKey] !== "string") {
      const fallbackCmd = firstStringArg(originalArgs, ...shellCommandCandidates());
      next[commandKey] = fallbackCmd ? fallbackCmd : "";
    }
  } else if (normalizedTool.includes("glob") || normalizedTool.includes("find")) {
    const requiredProperties = new Map(
      required.map((property) => [normalizeToolName(property), property]),
    );
    const patternKey = firstMatchingProperty(
      globPatternCandidates(),
      required,
      requiredProperties,
    );
    if (patternKey && typeof next[patternKey] !== "string") {
      const fallbackPattern = firstStringArg(originalArgs, ...globPatternCandidates());
      next[patternKey] = fallbackPattern ? fallbackPattern : "*";
    }
    const pathKey = firstMatchingProperty(
      globPathCandidates(),
      schema.properties,
      normalizedProperties,
    );
    if (
      pathKey &&
      required.includes(pathKey) &&
      !shouldIncludeOptionalPath(next[pathKey])
    ) {
      next[pathKey] = ".";
    }
  }
  return next;
}

export function sanitizeNormalizedToolArguments(
  output: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>,
): Record<string, unknown> {
  if (!isShellLikeTool(tool, originalArgs)) return output;
  const next = { ...output };
  const schema = toolParameterSchema(tool);
  const required = new Set(schema.required);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const seen = new Set<string>();
  for (const candidate of shellExplicitWorkdirCandidates()) {
    const key =
      firstMatchingProperty([candidate], schema.properties, normalizedProperties) ??
      candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isSyntheticSdkWorkingDirectory(next[key])) continue;
    if (required.has(key)) next[key] = ".";
    else delete next[key];
  }
  const commandKey = commandLikeProperty(tool) ?? "command";
  const command =
    typeof next[commandKey] === "string"
      ? next[commandKey]
      : firstStringArg(originalArgs, ...shellCommandCandidates());
  if (typeof command === "string" && shouldBackgroundShellCommand(command)) {
    next[commandKey] = backgroundShellCommand(command);
    if (typeof next.description === "string") {
      next.description = `Starts background process: ${next.description}`;
    }
  }
  return next;
}

export function mapToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined,
): { target: string; priority: number } | null {
  const exact = properties.includes(key)
    ? key
    : normalizedProperties.get(normalizeToolName(key));
  if (exact) return { target: exact, priority: 100 };
  return aliasToolArgument(key, properties, normalizedProperties, toolName);
}

export function aliasToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined,
): { target: string; priority: number } | null {
  const normalized = normalizeToolName(key);
  const rules = [
    ...toolSpecificArgumentAliases(normalizeToolName(toolName ?? ""), normalized),
    ...commonArgumentAliases(normalized),
  ];
  for (const rule of rules) {
    const target = firstMatchingProperty(
      rule.candidates,
      properties,
      normalizedProperties,
    );
    if (target) return { target, priority: rule.priority };
  }
  return null;
}
