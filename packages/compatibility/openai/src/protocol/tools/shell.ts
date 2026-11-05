import type { OpenAiToolSpec, ToolCallContext } from "../types.js";
import { normalizeToolName, canonicalToolName } from "./specs.js";
import {
  firstMatchingProperty,
  firstArg,
  firstStringArg,
  firstStringArgAllowEmpty,
  firstStringArrayArg,
  firstNumberArg,
  firstBooleanArg,
  pathCandidates,
  fileContentCandidates,
  oldTextCandidates,
  newTextCandidates,
  shellCommandCandidates,
  shellExplicitWorkdirCandidates,
  timeoutCandidates,
  shouldIncludeOptionalPath,
  normalizedGlobArguments,
} from "./candidates.js";
import { toolParameterSchema } from "./schema.js";
import { heredocDelimiter, hashString } from "./file-tools.js";

export interface ShellToolNormalizerDeps {
  normalizeToolArgumentValue: (
    value: unknown,
    targetProperty: string,
    tool: OpenAiToolSpec | undefined,
    context?: ToolCallContext,
    sourceProperty?: string,
  ) => unknown;
  applyRequiredToolDefaults: (
    output: Record<string, unknown>,
    required: string[],
    tool: OpenAiToolSpec | undefined,
    originalArgs: Record<string, unknown>,
  ) => Record<string, unknown>;
  sanitizeNormalizedToolArguments: (
    output: Record<string, unknown>,
    tool: OpenAiToolSpec | undefined,
    originalArgs: Record<string, unknown>,
  ) => Record<string, unknown>;
}

let shellDeps: ShellToolNormalizerDeps | undefined;

export function setShellToolNormalizerDeps(deps: ShellToolNormalizerDeps): void {
  shellDeps = deps;
}

export function canEmulateWithShell(emittedName: string): boolean {
  return [
    "write",
    "read",
    "edit",
    "delete",
    "grep",
    "glob",
    "ls",
    "semsearch",
  ].includes(canonicalToolName(emittedName));
}

export function shellFallbackArguments(
  args: Record<string, unknown>,
  emittedName: string,
  tool: OpenAiToolSpec | undefined,
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  const commandKey = firstMatchingProperty(
    shellCommandCandidates(),
    schema.properties,
    normalizedProperties,
  );
  const command = shellFallbackCommand(args, emittedName);
  if (!commandKey || !command) return args;
  const output: Record<string, unknown> = { [commandKey]: command };
  const workdir = firstArg(args, shellExplicitWorkdirCandidates());
  const workdirKey = firstMatchingProperty(
    shellExplicitWorkdirCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (workdirKey && shouldIncludeOptionalPath(workdir)) output[workdirKey] = workdir;
  const timeout = firstArg(args, timeoutCandidates());
  const timeoutKey = firstMatchingProperty(
    timeoutCandidates(),
    schema.properties,
    normalizedProperties,
  );
  if (timeoutKey && timeout !== undefined && shellDeps) {
    output[timeoutKey] = shellDeps.normalizeToolArgumentValue(
      timeout,
      timeoutKey,
      tool,
    );
  }
  const descriptionKey = firstMatchingProperty(
    ["description"],
    schema.properties,
    normalizedProperties,
  );
  if (descriptionKey) output[descriptionKey] = shellDescription(command);

  if (!shellDeps) return output;
  return shellDeps.sanitizeNormalizedToolArguments(
    shellDeps.applyRequiredToolDefaults(output, schema.required, tool, args),
    tool,
    args,
  );
}

export function shellFallbackCommand(
  args: Record<string, unknown>,
  emittedName: string,
): string | undefined {
  switch (canonicalToolName(emittedName)) {
    case "write": {
      const filePath = firstStringArg(args, ...pathCandidates());
      const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
      if (!filePath || content === undefined) return undefined;
      const delimiter = heredocDelimiter(content);
      return `mkdir -p "$(dirname ${shellQuote(filePath)})" && cat > ${shellQuote(filePath)} <<'${delimiter}'\n${content}\n${delimiter}`;
    }
    case "read": {
      const filePath = firstStringArg(args, ...pathCandidates());
      if (!filePath) return undefined;
      const offset = firstNumberArg(args, "offset", "start", "startLine", "start_line");
      const limit = firstNumberArg(
        args,
        "limit",
        "maxLines",
        "max_lines",
        "lineCount",
        "line_count",
      );
      if (offset !== undefined && limit !== undefined && limit > 0) {
        const start = Math.max(1, Math.floor(offset));
        const end = start + Math.floor(limit) - 1;
        return `sed -n ${shellQuote(`${start},${end}p`)} ${shellQuote(filePath)}`;
      }
      return `cat ${shellQuote(filePath)}`;
    }
    case "edit": {
      const filePath = firstStringArg(args, ...pathCandidates());
      const oldString = firstStringArgAllowEmpty(args, ...oldTextCandidates());
      const newString = firstStringArgAllowEmpty(args, ...newTextCandidates());
      if (!filePath || !oldString || newString === undefined) return undefined;
      const replaceAll =
        firstBooleanArg(
          args,
          "replaceAll",
          "replace_all",
          "replaceAllOccurrences",
          "replace_all_occurrences",
        ) === true;
      return `python3 - <<'PY'\nfrom pathlib import Path\npath = Path(${JSON.stringify(filePath)})\nold = ${JSON.stringify(oldString)}\nnew = ${JSON.stringify(newString)}\ntext = path.read_text()\nif old not in text:\n    raise SystemExit(f"oldString not found in {path}")\npath.write_text(text.replace(old, new, ${replaceAll ? "-1" : "1"}))\nPY`;
    }
    case "delete": {
      const filePath = firstStringArg(args, ...pathCandidates());
      if (!filePath) return undefined;
      return `rm -rf ${shellQuote(filePath)}`;
    }
    case "grep": {
      const pattern = firstStringArg(
        args,
        "pattern",
        "query",
        "regex",
        "search",
        "searchPattern",
        "search_pattern",
      );
      if (!pattern) return undefined;
      const targetPath =
        firstStringArg(args, ...pathCandidates(), "directory", "dir") ?? ".";
      const include = firstStringArg(
        args,
        "glob",
        "include",
        "includeGlob",
        "include_glob",
        "fileGlob",
        "file_glob",
        "includePattern",
        "include_pattern",
      );
      return [
        "rg",
        "--line-number",
        "--color",
        "never",
        "--hidden",
        include ? `--glob ${shellQuote(include)}` : "",
        shellQuote(pattern),
        shellQuote(targetPath),
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "glob": {
      const { pattern, path } = normalizedGlobArguments(args);
      return `python3 - <<'PY'\nfrom pathlib import Path\nbase = Path(${JSON.stringify(path ?? ".")})\npattern = ${JSON.stringify(pattern ?? "**/*")}\nfor item in sorted(base.glob(pattern)):\n    print(item)\nPY`;
    }
    case "ls": {
      return `ls -la ${shellQuote(firstStringArg(args, ...pathCandidates(), "directory", "dir") ?? ".")}`;
    }
    case "semsearch": {
      const query = firstStringArg(args, "query", "pattern", "search");
      if (!query) return undefined;
      const directories = firstStringArrayArg(
        args,
        "targetDirectories",
        "target_directories",
        "directories",
        "paths",
      );
      return [
        "rg",
        "--line-number",
        "--color",
        "never",
        "--hidden",
        shellQuote(query),
        ...(directories.length ? directories : ["."]).map(shellQuote),
      ].join(" ");
    }
    default:
      return undefined;
  }
}

export function isShellLikeTool(
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>,
): boolean {
  const normalizedTool = normalizeToolName(tool?.name ?? "");
  if (
    ["bash", "shell", "terminal"].includes(normalizedTool) ||
    canonicalToolName(tool?.name ?? "") === "shell"
  )
    return true;
  return Boolean(
    commandLikeProperty(tool) &&
    firstStringArg(originalArgs, ...shellCommandCandidates()),
  );
}

export function commandLikeProperty(
  tool: OpenAiToolSpec | undefined,
): string | undefined {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(
    schema.properties.map((property) => [normalizeToolName(property), property]),
  );
  return firstMatchingProperty(
    shellCommandCandidates(),
    schema.properties,
    normalizedProperties,
  );
}

export function commandLikeValue(
  output: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
): unknown {
  const commandKey = commandLikeProperty(tool);
  return commandKey ? output[commandKey] : output.command;
}

export function isSyntheticSdkWorkingDirectory(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["", ".", "/workspace", "workspace"].includes(value.trim())
  );
}

export function shellDescription(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) return "Runs shell command";
  const first = command.trim().split(/\s+/).slice(0, 5).join(" ");
  return `Runs ${first}`;
}

export function shouldBackgroundShellCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text || isAlreadyBackgroundedShellCommand(text)) return false;
  if (/\bpython(?:3(?:\.\d+)?)?\s+-m\s+http\.server\b/.test(text)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|preview)\b/.test(text))
    return true;
  if (/\b(?:npx|bunx)\s+(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text))
    return true;
  if (
    /\b(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text) &&
    /\b(?:--host|--port|localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(text)
  ) {
    return true;
  }
  return /\b(?:uvicorn|gunicorn|flask\s+run|php\s+-s)\b/.test(text);
}

export function isAlreadyBackgroundedShellCommand(command: string): boolean {
  return (
    /(^|[\s;&|])(?:nohup|setsid|tmux|screen)\b/.test(command) ||
    /(^|[^&])&\s*(?:$|[;|])/.test(command) ||
    /\bdisown\b|\$!/.test(command)
  );
}

export function backgroundShellCommand(command: string): string {
  const logPath = `/tmp/opencode-background-${hashString(command)}.log`;
  return `nohup sh -lc ${shellQuote(command)} > ${shellQuote(logPath)} 2>&1 & echo "Started background process pid=$! log=${logPath}"`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
