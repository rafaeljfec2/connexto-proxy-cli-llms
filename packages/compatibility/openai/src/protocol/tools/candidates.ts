import type { ToolCallContext } from "../types.js";
import { normalizeToolName } from "./specs.js";

export function pathCandidates(): string[] {
  return [
    "path",
    "file_path",
    "filePath",
    "filename",
    "file",
    "target",
    "targetPath",
    "target_path",
    "targetFile",
    "target_file",
    "absolutePath",
    "absolute_path",
    "relativePath",
    "relative_path",
  ];
}

export function fileContentCandidates(): string[] {
  return [
    "fileText",
    "file_text",
    "content",
    "contents",
    "text",
    "body",
    "data",
    "value",
    "newContents",
    "new_contents",
    "fileContent",
    "file_content",
    "streamContent",
    "stream_content",
  ];
}

export function oldTextCandidates(): string[] {
  return [
    "oldString",
    "old_string",
    "old_str",
    "oldText",
    "old_text",
    "oldContents",
    "old_contents",
    "old",
    "search",
    "searchString",
    "search_string",
    "find",
    "findText",
    "find_text",
  ];
}

export function newTextCandidates(): string[] {
  return [
    "newString",
    "new_string",
    "new_str",
    "newText",
    "new_text",
    "newContents",
    "new_contents",
    "replacement",
    "replace",
    "replaceWith",
    "replace_with",
    "content",
  ];
}

export function shellCommandCandidates(): string[] {
  return [
    "command",
    "cmd",
    "script",
    "input",
    "shellCommand",
    "shell_command",
    "commandLine",
    "command_line",
    "code",
  ];
}

export function shellWorkdirCandidates(): string[] {
  return [
    "workingDirectory",
    "working_directory",
    "workingDir",
    "working_dir",
    "workdir",
    "cwd",
    "directory",
    "dir",
    "path",
    "root",
    "rootDir",
    "root_dir",
    "projectRoot",
    "project_root",
  ];
}

export function shellExplicitWorkdirCandidates(): string[] {
  return shellWorkdirCandidates().filter(
    (candidate) => normalizeToolName(candidate) !== "path",
  );
}

export function timeoutCandidates(): string[] {
  return [
    "timeout",
    "timeoutMs",
    "timeout_ms",
    "timeoutMilliseconds",
    "timeout_milliseconds",
    "timeoutSeconds",
    "timeout_seconds",
    "seconds",
  ];
}

export function operationPropertyCandidates(): string[] {
  return ["command", "action", "operation", "op", "mode"];
}

export function firstArg(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(args)) {
    if (normalizedKeys.has(normalizeToolName(key))) return value;
  }
  return undefined;
}

export function firstStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function firstStringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = firstArg(args, keys);
  return typeof value === "string" ? value : undefined;
}

export function firstStringArrayArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string[] {
  const value = firstArg(args, keys);
  if (Array.isArray(value))
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  return typeof value === "string" && value.trim() ? [value] : [];
}

export function firstNumberArg(
  args: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function firstNumberNamedArg(
  args: Record<string, unknown>,
  ...keys: string[]
): { key: string; value: number } | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return { key, value };
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(args)) {
    if (
      normalizedKeys.has(normalizeToolName(key)) &&
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return { key, value };
    }
  }
  return undefined;
}

export function firstBooleanArg(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function shouldIncludeOptionalPath(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.toLowerCase() !== "undefined" && trimmed.toLowerCase() !== "null";
}

export function globPatternCandidates(
  options: { includeQuery?: boolean } = {},
): string[] {
  return [
    "globPattern",
    "glob_pattern",
    "fileGlob",
    "file_glob",
    "filePattern",
    "file_pattern",
    "includePattern",
    "include_pattern",
    "pathPattern",
    "path_pattern",
    "pattern",
    "glob",
    ...(options.includeQuery === false ? [] : ["query"]),
    "include",
    "includeGlob",
    "include_glob",
  ];
}

export function globPathCandidates(): string[] {
  return [
    "targetDirectory",
    "target_directory",
    "targeting",
    "directory",
    "dir",
    "cwd",
    "workdir",
    "workingDirectory",
    "working_directory",
    "path",
    "root",
    "rootDir",
    "root_dir",
    "basePath",
    "base_path",
    "searchPath",
    "search_path",
  ];
}

export function looksLikeGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value.trim());
}

export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/")
  );
}

export function looksLikeGlobSearchRoot(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if ([".", "./", "..", "../"].includes(trimmed)) return true;
  if (looksLikePath(trimmed) || trimmed.startsWith("~") || trimmed.startsWith("$"))
    return true;
  return !looksLikeGlobPattern(trimmed) && !/\.[^/.]+$/.test(trimmed);
}

export function splitGlobTargetPath(value: string): {
  path?: string;
  pattern?: string;
} {
  const trimmed = value.trim();
  const firstGlob = trimmed.search(/[*?[\]{}]/);
  if (firstGlob < 0) return { path: trimmed };
  const slash = trimmed.lastIndexOf("/", firstGlob);
  const base = slash > 0 ? trimmed.slice(0, slash) : slash === 0 ? "/" : "";
  const pattern = trimmed.slice(slash + 1).replace(/^\/+/, "");
  return { path: base ? base : undefined, pattern: pattern ? pattern : undefined };
}

export function firstMatchingProperty(
  candidates: string[],
  properties: string[],
  normalizedProperties: Map<string, string>,
): string | undefined {
  for (const candidate of candidates) {
    if (properties.includes(candidate)) return candidate;
    const normalized = normalizedProperties.get(normalizeToolName(candidate));
    if (normalized) return normalized;
  }
  return undefined;
}

export type GlobPathNormalizer = (value: string, context?: ToolCallContext) => string;
let globPathNormalizer: GlobPathNormalizer | undefined;

export function setGlobPathNormalizer(normalizer: GlobPathNormalizer): void {
  globPathNormalizer = normalizer;
}

export function normalizedGlobArguments(
  args: Record<string, unknown>,
  context?: ToolCallContext,
): { pattern?: string; path?: string } {
  let pattern = firstStringArg(args, ...globPatternCandidates());
  let targetPath = firstStringArg(args, ...globPathCandidates());
  if (targetPath && globPathNormalizer)
    targetPath = globPathNormalizer(targetPath, context);
  if (targetPath && looksLikeGlobPattern(targetPath)) {
    if (pattern && !looksLikeGlobPattern(pattern) && looksLikeGlobSearchRoot(pattern)) {
      const nextPattern = targetPath;
      targetPath = globPathNormalizer ? globPathNormalizer(pattern, context) : pattern;
      pattern = nextPattern;
    } else {
      const split = splitGlobTargetPath(targetPath);
      targetPath = split.path;
      pattern = combineGlobPatterns(split.pattern, pattern);
    }
  }
  return { pattern, path: targetPath };
}

export function combineGlobPatterns(
  targetPattern: string | undefined,
  pattern: string | undefined,
): string | undefined {
  const cleanTarget = targetPattern?.replace(/^\/+|\/+$/g, "");
  const cleanPattern = pattern?.replace(/^\/+/, "");
  if (!cleanTarget) return cleanPattern;
  if (!cleanPattern) return cleanTarget;
  if (cleanTarget === "**") return cleanPattern === "*" ? "**/*" : `**/${cleanPattern}`;
  if (cleanTarget === "*") return cleanPattern;
  if (cleanPattern === "*") return cleanTarget;
  return cleanPattern;
}
