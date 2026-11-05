import type { OpenAiToolSpec, ToolCallContext } from "../types.js";
import { normalizeToolName } from "./specs.js";
import {
  firstMatchingProperty,
  firstArg,
  firstStringArg,
  firstStringArgAllowEmpty,
  firstNumberArg,
  pathCandidates,
  fileContentCandidates,
  oldTextCandidates,
  newTextCandidates,
  globPatternCandidates,
  globPathCandidates,
  operationPropertyCandidates,
  shouldIncludeOptionalPath,
} from "./candidates.js";
import { toolParameterSchema, stringEnumValues } from "./schema.js";
import { normalizedGlobArguments } from "./candidates.js";

// Callbacks or imported helpers for circular-safe normalization
export interface FileToolNormalizerDeps {
  normalizeToolArgumentValue: (
    value: unknown,
    targetProperty: string,
    tool: OpenAiToolSpec | undefined,
    context?: ToolCallContext,
    sourceProperty?: string,
  ) => unknown;
}

let normalizerDeps: FileToolNormalizerDeps | undefined;

export function setFileToolNormalizerDeps(deps: FileToolNormalizerDeps): void {
  normalizerDeps = deps;
}

function normalizeArgValue(
  value: unknown,
  targetProperty: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
): unknown {
  return normalizerDeps
    ? normalizerDeps.normalizeToolArgumentValue(value, targetProperty, tool, context)
    : value;
}

export function heredocDelimiter(content: string): string {
  for (let index = 0; index <= 100; index += 1) {
    const delimiter = `API_FOR_CURSOR_EOF${index === 0 ? "" : `_${index}`}`;
    if (!content.includes(delimiter)) return delimiter;
  }
  return `API_FOR_CURSOR_EOF_${hashString(content)}`;
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function listAsGlobArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  const patternKey = firstMatchingProperty(
    globPatternCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (patternKey) output[patternKey] = Object.keys(args).length ? "*" : "**/*";
  const path = firstArg(args, globPathCandidates());
  const pathKey = firstMatchingProperty(
    globPathCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (pathKey && shouldIncludeOptionalPath(path))
    output[pathKey] = normalizeArgValue(path, pathKey, tool, context);
  else if (pathKey && schema.required.includes(pathKey)) output[pathKey] = ".";
  return Object.keys(output).length ? output : args;
}

export function globArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  const { pattern, path } = normalizedGlobArguments(args, context);
  const patternKey = firstMatchingProperty(
    globPatternCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (patternKey) output[patternKey] = pattern ?? "**/*";
  const pathKey = firstMatchingProperty(
    globPathCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (pathKey && shouldIncludeOptionalPath(path))
    output[pathKey] = normalizeArgValue(path, pathKey, tool, context);
  else if (pathKey && schema.required.includes(pathKey)) output[pathKey] = ".";
  return Object.keys(output).length ? output : args;
}

export function strReplaceEditorArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined,
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const properties = schema.properties.length
    ? schema.properties
    : ["command", "path", "file_text", "old_str", "new_str", "view_range"];
  const normalizedProperties = new Map(
    properties.map((property) => [normalizeToolName(property), property]),
  );
  const output: Record<string, unknown> = {};
  const set = (candidates: string[], value: unknown) => {
    const key = firstMatchingProperty(candidates, properties, normalizedProperties);
    if (key && value !== undefined) output[key] = value;
  };
  const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
  set(pathCandidates(), path);

  if (emittedCanonical === "read") {
    set(["command"], "view");
    const viewRange = viewRangeFromArgs(args);
    if (viewRange) set(["view_range", "viewRange", "range"], viewRange);
    return Object.keys(output).length ? output : args;
  }

  if (emittedCanonical === "edit") {
    const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
    const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
    if (oldText !== undefined && newText !== undefined) {
      set(["command"], "str_replace");
      set(["old_str", "oldString", "old_string", "old"], oldText);
      set(["new_str", "newString", "new_string", "replacement"], newText);
      return Object.keys(output).length ? output : args;
    }
  }

  const fileText = firstStringArgAllowEmpty(args, ...fileContentCandidates());
  if (fileText !== undefined) {
    set(["command"], "create");
    set(["file_text", "fileText", "content", "contents", "text"], fileText);
    return Object.keys(output).length ? output : args;
  }

  return Object.keys(output).length ? output : args;
}

export function viewRangeFromArgs(args: Record<string, unknown>): number[] | undefined {
  const offset = firstNumberArg(args, "offset", "start", "startLine", "start_line");
  const limit = firstNumberArg(
    args,
    "limit",
    "maxLines",
    "max_lines",
    "lineCount",
    "line_count",
  );
  if (offset === undefined && limit === undefined) return undefined;
  const start = Math.max(1, Math.trunc(offset ?? 1));
  if (limit === undefined || limit <= 0) return [start, -1];
  return [start, start + Math.trunc(limit) - 1];
}

export function commandStyleFileArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
): Record<string, unknown> | undefined {
  if (!["write", "read", "edit", "delete"].includes(emittedCanonical)) return undefined;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const operationKey = firstMatchingProperty(
    operationPropertyCandidates(),
    schema.properties,
    normalizedProperties,
  );
  const pathKey = firstMatchingProperty(
    pathCandidates(),
    schema.properties,
    normalizedProperties,
  );
  const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
  if (!operationKey || !pathKey || !shouldIncludeOptionalPath(path)) return undefined;

  const output: Record<string, unknown> = {
    [operationKey]: operationValue(tool, operationKey, emittedCanonical),
    [pathKey]: normalizeArgValue(path, pathKey, tool, context),
  };
  if (emittedCanonical === "write") {
    const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
    const contentKey = firstMatchingProperty(
      fileContentCandidates(),
      schema.properties,
      normalizedProperties,
    );
    if (!contentKey || content === undefined) return undefined;
    output[contentKey] = content;
  } else if (emittedCanonical === "edit") {
    const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
    const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
    const oldKey = firstMatchingProperty(
      oldTextCandidates(),
      schema.properties,
      normalizedProperties,
    );
    const newKey = firstMatchingProperty(
      newTextCandidates(),
      schema.properties,
      normalizedProperties,
    );
    if (!oldKey || !newKey || oldText === undefined || newText === undefined)
      return undefined;
    output[oldKey] = oldText;
    output[newKey] = newText;
  } else if (emittedCanonical === "read") {
    copyOptionalArgument(output, schema.properties, normalizedProperties, args, [
      "offset",
      "start",
      "startLine",
      "start_line",
    ]);
    copyOptionalArgument(output, schema.properties, normalizedProperties, args, [
      "limit",
      "maxLines",
      "max_lines",
      "lineCount",
      "line_count",
    ]);
  }
  return output;
}

export function copyOptionalArgument(
  output: Record<string, unknown>,
  properties: string[],
  normalizedProperties: Map<string, string>,
  args: Record<string, unknown>,
  candidates: string[],
): void {
  const value = firstArg(args, candidates);
  const key = firstMatchingProperty(candidates, properties, normalizedProperties);
  if (key && value !== undefined) output[key] = value;
}

export function commandStyleFileToolSupports(
  canonical: string,
  tool: OpenAiToolSpec,
): boolean {
  if (!["write", "read", "edit", "delete"].includes(canonical)) return false;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const has = (candidates: string[]) =>
    Boolean(firstMatchingProperty(candidates, schema.properties, normalizedProperties));
  if (!has(operationPropertyCandidates()) || !has(pathCandidates())) return false;
  if (canonical === "write") return has(fileContentCandidates());
  if (canonical === "edit") {
    return has(oldTextCandidates()) && has(newTextCandidates());
  }
  return true;
}

export function operationValue(
  tool: OpenAiToolSpec | undefined,
  property: string,
  canonical: string,
): string {
  const candidates: Record<string, string[]> = {
    write: ["write", "create", "overwrite", "replace"],
    read: ["read", "view", "open"],
    edit: ["replace", "str_replace", "edit", "update"],
    delete: ["delete", "remove"],
  };
  const allowed = stringEnumValues(tool, property);
  for (const candidate of candidates[canonical] ?? [canonical]) {
    const allowedMatch = allowed.find(
      (value) => normalizeToolName(value) === normalizeToolName(candidate),
    );
    if (allowedMatch) return allowedMatch;
  }
  return (candidates[canonical] ?? [canonical])[0];
}

export function patchStyleFileArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
): Record<string, unknown> | undefined {
  if (!["write", "edit", "delete"].includes(emittedCanonical)) return undefined;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const patchKey = patchPropertyKey(tool, schema.properties, normalizedProperties);
  if (!patchKey) return undefined;
  const path = firstStringArg(args, ...pathCandidates(), "target_file", "targetFile");

  let patch: string | undefined;
  if (emittedCanonical === "write") {
    if (!path) return undefined;
    const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
    if (content === undefined) return undefined;
    patch = addFilePatch(path, content);
  } else if (emittedCanonical === "edit") {
    const patchContent = firstStringArgAllowEmpty(
      args,
      "patchContent",
      "patch_content",
      "patch",
      "diff",
      "unifiedDiff",
      "unified_diff",
    );
    if (patchContent !== undefined) {
      patch = patchContent;
    } else {
      if (!path) return undefined;
      const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
      const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
      if (oldText === undefined || newText === undefined) return undefined;
      patch = updateFilePatch(path, oldText, newText);
    }
  } else {
    if (!path) return undefined;
    patch = deleteFilePatch(path);
  }

  const output: Record<string, unknown> = { [patchKey]: patch };
  const pathKey = firstMatchingProperty(
    pathCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (path && pathKey) {
    output[pathKey] = normalizeArgValue(path, pathKey, tool, context);
  } else if (pathKey && schema.required.includes(pathKey)) {
    return undefined;
  }
  return output;
}

export function patchStyleFileToolSupports(
  canonical: string,
  tool: OpenAiToolSpec,
): boolean {
  if (!["write", "edit", "delete"].includes(canonical)) return false;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  return Boolean(patchPropertyKey(tool, schema.properties, normalizedProperties));
}

export function patchPropertyKey(
  tool: OpenAiToolSpec | undefined,
  properties: string[],
  normalizedProperties: Map<string, string>,
): string | undefined {
  const direct = firstMatchingProperty(
    ["patch", "diff", "unifiedDiff", "unified_diff"],
    properties,
    normalizedProperties,
  );
  if (direct) return direct;
  const normalizedTool = normalizeToolName(tool?.name ?? "");
  if (!normalizedTool.includes("patch")) return undefined;
  return firstMatchingProperty(
    ["input", "content", "text"],
    properties,
    normalizedProperties,
  );
}

export function addFilePatch(path: string, content: string): string {
  return [
    "*** Begin Patch",
    `*** Add File: ${path}`,
    ...patchLines(content, "+"),
    "*** End Patch",
  ].join("\n");
}

export function updateFilePatch(
  path: string,
  oldText: string,
  newText: string,
): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...patchLines(oldText, "-"),
    ...patchLines(newText, "+"),
    "*** End Patch",
  ].join("\n");
}

export function deleteFilePatch(path: string): string {
  return ["*** Begin Patch", `*** Delete File: ${path}`, "*** End Patch"].join("\n");
}

export function patchLines(text: string, prefix: "+" | "-"): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [`${prefix}`];
  if (lines[lines.length - 1] === "") lines.pop();
  return (lines.length ? lines : [""]).map((line) => `${prefix}${line}`);
}
