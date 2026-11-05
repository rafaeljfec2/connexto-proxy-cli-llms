import type { OpenAiToolSpec } from "../types.js";
import { KNOWN_SDK_CANONICAL_TOOLS } from "../constants.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import {
  firstMatchingProperty,
  pathCandidates,
  fileContentCandidates,
  oldTextCandidates,
  newTextCandidates,
  shellCommandCandidates,
  globPatternCandidates,
} from "./candidates.js";
import { toolParameterSchema } from "./schema.js";
import { wrapperObjectArgumentProperty } from "./mcp-wrapper.js";
import {
  commandStyleFileToolSupports,
  patchStyleFileToolSupports,
} from "./file-tools.js";
import { toolNameAliases } from "./aliases.js";

export function schemaLooksCompatible(
  emittedName: string,
  tool: OpenAiToolSpec,
): boolean {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const has = (candidates: string[]) =>
    Boolean(firstMatchingProperty(candidates, schema.properties, normalizedProperties));
  const canonical = canonicalToolName(emittedName);
  const wrapper = wrapperObjectArgumentProperty(tool, schema);
  if (wrapper) {
    if (
      canonical === "mcp" &&
      (has(["toolName", "tool_name", "tool", "name"]) ||
        normalizeToolName(tool.name).includes("mcp"))
    ) {
      return true;
    }
    return schemaLooksCompatible(emittedName, {
      ...tool,
      parameters: wrapper.parameters,
    });
  }
  if (
    normalizeToolName(tool.name) === "strreplaceeditor" &&
    !["write", "read", "edit"].includes(canonical)
  ) {
    return false;
  }
  if (commandStyleFileToolSupports(canonical, tool)) {
    return true;
  }
  if (patchStyleFileToolSupports(canonical, tool)) {
    return true;
  }
  const toolCanonical = canonicalToolName(tool.name);
  switch (canonical) {
    case "shell":
      return has(shellCommandCandidates());
    case "write":
      return has(pathCandidates()) && has(fileContentCandidates());
    case "read":
      return has(pathCandidates());
    case "delete":
      return toolCanonical === "delete" && has(pathCandidates());
    case "edit":
      return (
        has(pathCandidates()) && has(oldTextCandidates()) && has(newTextCandidates())
      );
    case "grep":
      return has(["pattern", "query", "regex", "search"]);
    case "glob":
      return (
        has(globPatternCandidates({ includeQuery: false })) ||
        (canonicalToolName(tool.name) === "glob" && has(["query"]))
      );
    case "ls":
      return has([...pathCandidates(), "directory", "dir"]);
    case "readlints":
      return has(["paths", "files", "filePaths", "file_paths"]);
    case "mcp":
      return has(["toolName", "tool_name", "tool", "name"]);
    case "semsearch":
      return toolCanonical === "semsearch" && has(["query", "pattern", "search"]);
    case "todowrite":
      return has(["todos", "todoList", "todo_list", "items"]);
    default:
      return false;
  }
}

export function schemaCompatibilityScore(
  emittedName: string,
  tool: OpenAiToolSpec,
): number {
  if (!schemaLooksCompatible(emittedName, tool)) return 0;
  const emittedCanonical = canonicalToolName(emittedName);
  const toolCanonical = canonicalToolName(tool.name);
  if (toolCanonical === emittedCanonical) return 100;
  if (
    toolNameAliases(normalizeToolName(emittedName)).includes(
      normalizeToolName(tool.name),
    )
  )
    return 95;
  if (emittedCanonical === "write" && normalizeToolName(tool.name).includes("edit"))
    return 80;
  if (emittedCanonical === "ls" && toolCanonical === "read") return 20;
  return 50;
}

export function nameMatchedToolCanAccept(
  emittedName: string,
  tool: OpenAiToolSpec,
): boolean {
  if (!KNOWN_SDK_CANONICAL_TOOLS.has(canonicalToolName(emittedName))) return true;
  if (!toolParameterSchema(tool).properties.length) return true;
  return schemaLooksCompatible(emittedName, tool);
}
