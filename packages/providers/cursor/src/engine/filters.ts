import {
  isRecord,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import { firstString } from "./utils.js";

export const COMPOSER_CONTROL_TOKEN_PATTERN =
  /<\/think>|<\s*[|｜]\s*final\s*[|｜]\s*>/gi;

export const TOOL_CALLS_BEGIN = "<|tool_calls_begin|>";
export const TOOL_CALLS_END = "<|tool_calls_end|>";
export const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
export const TOOL_CALL_END = "<|tool_call_end|>";
export const TOOL_SEP = "<|tool_sep|>";
export const TOOL_MARKER_CANDIDATES = [
  TOOL_CALLS_BEGIN,
  TOOL_CALLS_END,
  TOOL_CALL_BEGIN,
  TOOL_CALL_END,
  TOOL_SEP,
].flatMap((marker) => [marker, marker.replaceAll("|", "｜").replaceAll("_", "▁")]);

export type ComposerToolMarkerEvent =
  { type: "text"; text: string } | { type: "tool_call"; toolCall: CursorToolCall };

export function findComposerControlToken(
  value: string,
): { index: number; length: number } | null {
  let found: { index: number; length: number } | null = null;
  const pattern = new RegExp(COMPOSER_CONTROL_TOKEN_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    found = { index: match.index, length: match[0].length };
  }
  return found;
}

export function stripComposerControlTokens(value: string): string {
  const marker = findComposerControlToken(value);
  if (!marker) return value;
  return value
    .slice(marker.index + marker.length)
    .replace(COMPOSER_CONTROL_TOKEN_PATTERN, "")
    .replace(/^\s+/, "");
}

export class ComposerToolCallFilter {
  private buffer = "";

  push(delta: string): ComposerToolMarkerEvent[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): ComposerToolMarkerEvent[] {
    return this.drain(true);
  }

  private drain(force: boolean): ComposerToolMarkerEvent[] {
    const events: ComposerToolMarkerEvent[] = [];
    for (;;) {
      const begin = findComposerToolMarker(this.buffer, "tool_calls_begin");
      if (!begin) {
        if (!this.buffer.trim()) {
          if (force) this.buffer = "";
          break;
        }
        const prefixIndex = force ? -1 : toolMarkerPrefixIndex(this.buffer);
        if (prefixIndex !== -1) {
          const visible = this.buffer.slice(0, prefixIndex);
          if (visible.trim()) events.push({ type: "text", text: visible });
          this.buffer = this.buffer.slice(prefixIndex);
          break;
        }
        const visible = this.buffer;
        if (visible) events.push({ type: "text", text: visible });
        this.buffer = "";
        break;
      }

      if (begin.index > 0) {
        const before = this.buffer.slice(0, begin.index);
        if (before.trim()) events.push({ type: "text", text: before });
        this.buffer = this.buffer.slice(begin.index);
        continue;
      }

      const end = findComposerToolMarker(
        this.buffer.slice(begin.length),
        "tool_calls_end",
      );
      if (!end) {
        if (force) {
          events.push({ type: "text", text: this.buffer });
          this.buffer = "";
        }
        break;
      }

      const blockEnd = begin.length + end.index + end.length;
      const block = this.buffer.slice(0, blockEnd);
      for (const toolCall of parseComposerToolCalls(block)) {
        events.push({ type: "tool_call", toolCall });
      }
      this.buffer = this.buffer.slice(blockEnd).replace(/^\s+/, "");
    }
    return events;
  }
}

export function parseComposerToolCalls(value: string): CursorToolCall[] {
  const normalized = canonicalizeComposerToolMarkers(value);
  const beginIndex = normalized.indexOf(TOOL_CALLS_BEGIN);
  const endIndex = normalized.lastIndexOf(TOOL_CALLS_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) return [];

  const body = normalized.slice(beginIndex + TOOL_CALLS_BEGIN.length, endIndex);
  const calls: CursorToolCall[] = [];
  let offset = 0;
  for (;;) {
    const start = body.indexOf(TOOL_CALL_BEGIN, offset);
    if (start === -1) break;
    const contentStart = start + TOOL_CALL_BEGIN.length;
    const end = body.indexOf(TOOL_CALL_END, contentStart);
    if (end === -1) break;
    const call = parseComposerToolCallBody(body.slice(contentStart, end));
    if (call) calls.push(call);
    offset = end + TOOL_CALL_END.length;
  }
  return calls;
}

export function parseComposerToolCallBody(value: string): CursorToolCall | null {
  const trimmedBody = value.trim();
  const jsonBody = parseJsonToolCallBody(trimmedBody);
  if (jsonBody) return jsonBody;

  const parts = value.split(TOOL_SEP);
  const name = (parts.shift() ?? "").trim();
  if (!name) return null;

  if (!parts.length) {
    const inline = parseInlineToolCall(name);
    return inline ?? { name, arguments: {} };
  }

  const args: Record<string, unknown> = {};
  for (const part of parts) {
    const trimmed = part.replace(/^\s+/, "");
    if (!trimmed) continue;
    const match = /^([^\r\n]+)(?:\r?\n([\s\S]*))?$/.exec(trimmed);
    if (!match) continue;
    const key = match[1].trim();
    if (!key) continue;
    const rawValue = (match[2] ?? "").trim();
    args[key] = parseComposerToolArgument(rawValue);
  }

  return { name, arguments: args };
}

export function parseJsonToolCallBody(value: string): CursorToolCall | null {
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const fn = isRecord(parsed.function) ? parsed.function : undefined;
    const name = firstString(
      parsed.name,
      parsed.tool,
      parsed.tool_name,
      parsed.toolName,
      fn?.name,
    );
    if (!name) return null;
    const rawArguments =
      parsed.arguments ??
      parsed.args ??
      parsed.input ??
      parsed.parameters ??
      parsed.params ??
      fn?.arguments;
    return { name, arguments: recordFromToolArguments(rawArguments) ?? {} };
  } catch {
    return null;
  }
}

export function recordFromToolArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const decoded = JSON.parse(value) as unknown;
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function parseInlineToolCall(value: string): CursorToolCall | null {
  const match = /^([A-Za-z0-9_.-]+)\s*(?:\(([\s\S]*)\)|\[([\s\S]*)\])?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const name = match[1].trim();
  const rawArgs = (match[2] ?? match[3] ?? "").trim();
  const args = rawArgs ? parseInlineToolArguments(rawArgs) : {};
  return { name, arguments: args };
}

export function parseInlineToolArguments(value: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitInlineArguments(value)) {
    const match = /^([A-Za-z0-9_.-]+)\s*[:=]\s*([\s\S]*)$/.exec(part.trim());
    if (!match) continue;
    args[match[1]] = parseComposerToolArgument(match[2].trim());
  }
  return args;
}

export function splitInlineArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export function parseComposerToolArgument(value: string): unknown {
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function canonicalizeComposerToolMarkers(value: string): string {
  return value.replace(
    /<\s*[|｜]\s*(tool[_▁]calls[_▁]begin|tool[_▁]calls[_▁]end|tool[_▁]call[_▁]begin|tool[_▁]call[_▁]end|tool[_▁]sep)\s*[|｜]\s*>/g,
    (_match, marker: string) => `<|${marker.replaceAll("▁", "_")}|>`,
  );
}

export function findComposerToolMarker(
  value: string,
  marker: string,
): { index: number; length: number } | null {
  const markerPattern = marker.replaceAll("_", "[_▁]");
  const pattern = new RegExp(`<\\s*[|｜]\\s*${markerPattern}\\s*[|｜]\\s*>`);
  const match = pattern.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

export function toolMarkerPrefixIndex(value: string): number {
  const max = Math.min(
    value.length,
    Math.max(...TOOL_MARKER_CANDIDATES.map((candidate) => candidate.length)),
  );
  for (let length = max; length >= 1; length -= 1) {
    const index = value.length - length;
    const suffix = value.slice(index);
    if (TOOL_MARKER_CANDIDATES.some((candidate) => candidate.startsWith(suffix)))
      return index;
  }
  return -1;
}

export function decodeBinaryToolCall(
  _payload: Uint8Array,
): { toolCall: CursorToolCall } | Record<string, never> {
  void _payload;
  return {};
}

export class ThinkingTextExtractor {
  private buffer = "";
  private open = true;

  push(delta: string): string[] {
    if (!this.open) return [delta];
    this.buffer += delta;
    const marker = this.findFinalMarker();
    if (!marker) return [];
    this.open = false;
    const after = this.buffer.slice(marker.index + marker.length).replace(/^\s+/, "");
    this.buffer = "";
    return after ? [after] : [];
  }

  flush(): string {
    if (!this.open) return "";
    const marker = this.findFinalMarker();
    if (marker) {
      const after = this.buffer.slice(marker.index + marker.length).replace(/^\s+/, "");
      this.buffer = "";
      return after;
    }
    this.buffer = "";
    return "";
  }

  private findFinalMarker(): { index: number; length: number } | null {
    return findComposerControlToken(this.buffer);
  }
}

export class ComposerOutputFilter {
  private buffer = "";

  push(delta: string): string[] {
    this.buffer += delta;
    const marker = findComposerControlToken(this.buffer);
    if (marker) {
      const after = this.buffer.slice(marker.index + marker.length).replace(/^\s+/, "");
      this.buffer = "";
      return after ? [after] : [];
    }

    const keep = controlTokenPrefixLength(this.buffer);
    if (keep === this.buffer.length) return [];
    const visible = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    return visible ? [visible] : [];
  }

  flush(): string[] {
    const marker = findComposerControlToken(this.buffer);
    const visible = marker
      ? this.buffer.slice(marker.index + marker.length).replace(/^\s+/, "")
      : this.buffer;
    this.buffer = "";
    return visible ? [visible] : [];
  }
}

export function controlTokenPrefixLength(value: string): number {
  const candidates = ["</think>", "<|final|>", "<｜final｜>", "< | final | >"];
  let keep = 0;
  const max = Math.min(
    value.length,
    Math.max(...candidates.map((candidate) => candidate.length)),
  );
  for (let length = 1; length <= max; length += 1) {
    const suffix = value.slice(value.length - length);
    if (candidates.some((candidate) => candidate.startsWith(suffix))) keep = length;
  }
  return keep;
}
