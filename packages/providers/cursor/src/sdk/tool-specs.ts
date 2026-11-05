import type { ArgsKind, ProtobufField, ToolSpec } from "./types.js";
import {
  booleanField,
  bytesField,
  numberField,
  stringField,
  stringFields,
} from "./proto.js";
import { decodeProtobufFields } from "../engine/connect-proto.js";

export const TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  1: { name: "shell", argsKind: "shell" },
  3: { name: "delete", argsKind: "delete" },
  4: { name: "glob", argsKind: "glob" },
  5: { name: "grep", argsKind: "grep" },
  8: { name: "read", argsKind: "readTool" },
  12: { name: "edit", argsKind: "edit" },
  13: { name: "ls", argsKind: "ls" },
  14: { name: "readLints", argsKind: "readLints" },
  15: { name: "mcp", argsKind: "mcp" },
  16: { name: "semSearch", argsKind: "semSearch" },
};

export const EXEC_TOOL_SPECS: Record<number, ToolSpec> = {
  2: { name: "shell", argsKind: "shell" },
  3: { name: "write", argsKind: "write" },
  4: { name: "delete", argsKind: "delete" },
  5: { name: "grep", argsKind: "grep" },
  7: { name: "read", argsKind: "readExec" },
  8: { name: "ls", argsKind: "ls" },
  9: { name: "readLints", argsKind: "readLints" },
  11: { name: "mcp", argsKind: "mcp" },
  14: { name: "shell", argsKind: "shell" },
};

export function decodeToolArgs(
  kind: ArgsKind,
  payload: Uint8Array,
): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  switch (kind) {
    case "shell":
      return compactToolRecord({
        command: stringField(fields, 1),
        workingDirectory: stringField(fields, 2),
        timeout: numberField(fields, 3),
        toolCallId: stringField(fields, 4),
      });
    case "write":
      return compactToolRecord({
        path: stringField(fields, 1),
        fileText: stringField(fields, 2),
        toolCallId: stringField(fields, 3),
        returnFileContentAfterWrite: booleanField(fields, 4),
      });
    case "delete":
      return compactToolRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
      });
    case "glob":
      return compactToolRecord({
        targetDirectory: stringField(fields, 1),
        globPattern: stringField(fields, 2),
      });
    case "grep":
      return compactToolRecord({
        pattern: stringField(fields, 1),
        path: stringField(fields, 2),
        glob: stringField(fields, 3),
        outputMode: stringField(fields, 4),
        contextBefore: numberField(fields, 5),
        contextAfter: numberField(fields, 6),
        context: numberField(fields, 7),
        caseInsensitive: booleanField(fields, 8),
        type: stringField(fields, 9),
        headLimit: numberField(fields, 10),
        multiline: booleanField(fields, 11),
        sort: stringField(fields, 12),
        sortAscending: booleanField(fields, 13),
        toolCallId: stringField(fields, 14),
        offset: numberField(fields, 16),
      });
    case "readTool":
      return compactToolRecord({
        path: stringField(fields, 1),
        offset: numberField(fields, 2),
        limit: numberField(fields, 3),
        includeLineNumbers: booleanField(fields, 5),
      });
    case "readExec":
      return compactToolRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
        offset: numberField(fields, 4),
        limit: numberField(fields, 5),
      });
    case "edit":
      return compactToolRecord({
        path: stringField(fields, 1),
        streamContent: stringField(fields, 6),
      });
    case "ls":
      return compactToolRecord({
        path: stringField(fields, 1),
        ignore: stringFields(fields, 2),
        toolCallId: stringField(fields, 3),
      });
    case "readLints":
      return compactToolRecord({ paths: stringFields(fields, 1) });
    case "mcp":
      return compactToolRecord({
        name: stringField(fields, 1),
        args: protoValueMap(fields, 2),
        toolCallId: stringField(fields, 3),
        providerIdentifier: stringField(fields, 4),
        toolName: stringField(fields, 5),
      });
    case "semSearch":
      return compactToolRecord({
        query: stringField(fields, 1),
        targetDirectories: stringFields(fields, 2),
        explanation: stringField(fields, 3),
      });
  }
}

export function protoValueMap(
  fields: ProtobufField[],
  fieldNumber: number,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.no !== fieldNumber || !(field.value instanceof Uint8Array)) continue;
    const entryFields = decodeProtobufFields(field.value);
    const key = stringField(entryFields, 1);
    const valueBytes = bytesField(entryFields, 2);
    const value = valueBytes ? protoValue(valueBytes) : undefined;
    if (key && value !== undefined) output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

export function protoValue(bytes: Uint8Array): unknown {
  const fields = decodeProtobufFields(bytes);
  if (fields.some((field) => field.no === 1)) return null;
  const numberValue = numberField(fields, 2);
  if (numberValue !== undefined) return numberValue;
  const stringValue = stringField(fields, 3);
  if (stringValue !== undefined) return stringValue;
  const boolValue = booleanField(fields, 4);
  if (boolValue !== undefined) return boolValue;
  const structValue = bytesField(fields, 5);
  if (structValue) return protoStruct(structValue);
  const listValue = bytesField(fields, 6);
  if (listValue) return protoList(listValue);
  return undefined;
}

export function protoStruct(bytes: Uint8Array): Record<string, unknown> {
  return protoValueMap(decodeProtobufFields(bytes), 1) ?? {};
}

export function protoList(bytes: Uint8Array): unknown[] {
  const output: unknown[] = [];
  for (const field of decodeProtobufFields(bytes)) {
    if (field.no !== 1 || !(field.value instanceof Uint8Array)) continue;
    const value = protoValue(field.value);
    if (value !== undefined) output.push(value);
  }
  return output;
}

export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

export function stringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function hasStringArg(args: Record<string, unknown>, key: string): boolean {
  return typeof args[key] === "string" && args[key].trim().length > 0;
}

export function hasAnyStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => hasStringArg(args, key));
}

export function hasAnyStringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => typeof args[key] === "string");
}

export function hasGlobRequest(args: Record<string, unknown>): boolean {
  if (
    hasAnyStringArg(
      args,
      "globPattern",
      "glob_pattern",
      "filePattern",
      "file_pattern",
      "pattern",
      "glob",
      "query",
      "include",
      "includeGlob",
      "include_glob",
    )
  ) {
    return true;
  }
  const target =
    stringArg(args, "targetDirectory") ??
    stringArg(args, "target_directory") ??
    stringArg(args, "targeting") ??
    stringArg(args, "path");
  return typeof target === "string" && /[*?[\]{}]/.test(target);
}

export function compactToolRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0),
    ),
  );
}

export const compactRecord = compactToolRecord;
