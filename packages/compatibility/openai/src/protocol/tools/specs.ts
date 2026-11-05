import { HttpError } from "../../http.js";
import type { OpenAiToolSpec } from "../types.js";
import { expectRecord, isRecord } from "../common.js";
import { isGlobLikeToolName } from "./aliases.js";

export function parseChatTools(value: unknown): OpenAiToolSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new HttpError(
      "tools must be an array.",
      400,
      "invalid_request_error",
      "tools",
    );
  return value.flatMap((tool, index) => {
    const record = expectRecord(tool, `tools[${index}]`);
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const fn = isRecord(record.function) ? record.function : record;
    const name =
      typeof fn.name === "string" && fn.name.trim()
        ? fn.name.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : "";
    if (!name) {
      if (type && type !== "function") return [];
      throw new HttpError(
        "Tool function name is required.",
        400,
        "invalid_request_error",
        `tools[${index}].function.name`,
      );
    }
    const description =
      typeof fn.description === "string"
        ? fn.description
        : typeof record.description === "string"
          ? record.description
          : undefined;
    const parameters = toolParametersFrom(fn, record);
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
      },
    ];
  });
}

export function toolParametersFrom(...records: Record<string, unknown>[]): unknown {
  for (const record of records) {
    for (const key of [
      "parameters",
      "input_schema",
      "inputSchema",
      "schema",
      "json_schema",
    ]) {
      if (record[key] !== undefined) return record[key];
    }
  }
  return undefined;
}

export function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function canonicalToolName(value: string): string {
  const normalized = normalizeToolName(value);
  if (
    [
      "bash",
      "runshellcommand",
      "runterminalcommand",
      "runterminalcmd",
      "terminal",
      "execute",
      "executecommand",
      "runcommand",
      "run",
    ].includes(normalized)
  ) {
    return "shell";
  }
  if (["writefile", "createfile", "strreplaceeditor"].includes(normalized))
    return "write";
  if (["readfile", "openfile", "viewfile"].includes(normalized)) return "read";
  if (["editfile", "replacefile", "searchreplace"].includes(normalized)) return "edit";
  if (["deletefile", "removefile"].includes(normalized)) return "delete";
  if (
    ["search", "searchfiles", "searchfilesystem", "ripgrep", "rg"].includes(normalized)
  )
    return "grep";
  if (isGlobLikeToolName(normalized)) return "glob";
  if (["list", "listfiles", "listdirectory", "listdir"].includes(normalized))
    return "ls";
  if (["readlints", "diagnostics", "getdiagnostics"].includes(normalized))
    return "readlints";
  if (["callmcptool"].includes(normalized)) return "mcp";
  if (["semanticsearch", "semsearch", "searchcode"].includes(normalized))
    return "semsearch";
  if (
    [
      "updatetodos",
      "updatetodostoolcall",
      "writetodos",
      "todowrite",
      "todowritetoolcall",
    ].includes(normalized)
  )
    return "todowrite";
  return normalized;
}

export function mcpTargetForClientToolName(
  name: string,
  options: { includeMapped?: boolean } = {},
): { provider: string; toolName: string } | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (isKnownMappedToolName(trimmed)) {
    return options.includeMapped
      ? { provider: "client", toolName: trimmed }
      : undefined;
  }
  if (trimmed.startsWith("mcp__")) {
    const parts = trimmed.split("__").filter(Boolean);
    if (parts.length >= 3)
      return { provider: parts[1], toolName: parts.slice(2).join("__") };
  }
  const index = trimmed.indexOf("_");
  if (index > 0 && index < trimmed.length - 1) {
    return { provider: trimmed.slice(0, index), toolName: trimmed.slice(index + 1) };
  }
  return { provider: "client", toolName: trimmed };
}

export function isKnownMappedToolName(name: string): boolean {
  return new Set([
    "bash",
    "shell",
    "terminal",
    "runterminalcmd",
    "runterminalcommand",
    "runshellcommand",
    "write",
    "writefile",
    "createfile",
    "read",
    "readfile",
    "openfile",
    "edit",
    "editfile",
    "replacefile",
    "delete",
    "deletefile",
    "removefile",
    "glob",
    "fileglob",
    "find",
    "findfile",
    "findfiles",
    "grep",
    "search",
    "searchfiles",
    "ls",
    "list",
    "listfiles",
    "readlints",
    "diagnostics",
    "todowrite",
    "updatetodos",
  ]).has(normalizeToolName(name));
}

export function toolInventoryRecord(
  tool: OpenAiToolSpec,
  options: { includeSdkMcp: boolean },
): Record<string, unknown> {
  const target = options.includeSdkMcp
    ? mcpTargetForClientToolName(tool.name, { includeMapped: false })
    : undefined;
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    ...(target
      ? {
          sdk_mcp: {
            providerIdentifier: target.provider,
            toolName: target.toolName,
            args: "match this tool schema",
          },
        }
      : {}),
  };
}
