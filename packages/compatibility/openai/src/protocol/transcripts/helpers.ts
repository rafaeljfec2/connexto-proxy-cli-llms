import type { CursorImage } from "../../types.js";
import type { ToolCallContext } from "../types.js";
import { HttpError } from "../../http.js";
import { isRecord, integerOrNull } from "../common.js";
import { sanitizeContextPath } from "../tools/normalizers.js";
import { contentToPlainText } from "../tools/workspace.js";

export function validateCommonUnsupported(record: Record<string, unknown>): void {
  if (typeof record.n === "number" && record.n !== 1) {
    throw new HttpError("Only n=1 is supported.", 400, "unsupported_parameter", "n");
  }
  if (record.logprobs === true || record.top_logprobs !== undefined) {
    throw new HttpError(
      "logprobs are not available through Cursor's API.",
      400,
      "unsupported_parameter",
      "logprobs",
    );
  }
  if (
    Array.isArray(record.modalities) &&
    record.modalities.some((value) => value !== "text")
  ) {
    throw new HttpError(
      "Only text output is supported.",
      400,
      "unsupported_parameter",
      "modalities",
    );
  }
  if (record.audio !== undefined) {
    throw new HttpError(
      "Audio output is not supported.",
      400,
      "unsupported_parameter",
      "audio",
    );
  }
}

export function appendChatOptions(
  transcript: string[],
  record: Record<string, unknown>,
): void {
  const constraints: string[] = [];
  const maxTokens = integerOrNull(record.max_completion_tokens ?? record.max_tokens);
  if (maxTokens)
    constraints.push(`Keep the answer within about ${maxTokens} output tokens.`);
  appendStopConstraint(constraints, record.stop);
  appendJsonConstraint(constraints, record.response_format);
  if (constraints.length)
    transcript.push(
      "",
      "OUTPUT CONSTRAINTS:",
      ...constraints.map((item) => `- ${item}`),
    );
}

export function appendResponseOptions(
  transcript: string[],
  record: Record<string, unknown>,
): void {
  const constraints: string[] = [];
  const maxTokens = integerOrNull(record.max_output_tokens);
  if (maxTokens)
    constraints.push(`Keep the answer within about ${maxTokens} output tokens.`);
  appendStopConstraint(constraints, record.stop);
  const text = isRecord(record.text) ? record.text : undefined;
  appendJsonConstraint(constraints, text?.format);
  if (constraints.length)
    transcript.push(
      "",
      "OUTPUT CONSTRAINTS:",
      ...constraints.map((item) => `- ${item}`),
    );
}

export function appendStopConstraint(constraints: string[], stop: unknown): void {
  if (typeof stop === "string")
    constraints.push(`Do not include text after this stop sequence: ${stop}`);
  else if (Array.isArray(stop) && stop.length)
    constraints.push(`Stop before any of these sequences: ${stop.join(", ")}`);
}

export function appendJsonConstraint(constraints: string[], format: unknown): void {
  if (!isRecord(format)) return;
  if (format.type === "json_object")
    constraints.push("Return a single valid JSON object and no surrounding prose.");
  if (format.type === "json_schema") {
    const schema = isRecord(format.json_schema)
      ? format.json_schema.schema
      : format.schema;
    constraints.push(
      `Return JSON that matches this schema: ${JSON.stringify(schema ?? format)}`,
    );
  }
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

export function imageFromUrl(
  url: string,
  metadata?: Record<string, unknown>,
): CursorImage {
  const dimension =
    typeof metadata?.width === "number" &&
    typeof metadata.height === "number" &&
    Number.isFinite(metadata.width) &&
    Number.isFinite(metadata.height)
      ? { width: Math.round(metadata.width), height: Math.round(metadata.height) }
      : undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrl) {
    return {
      mimeType: dataUrl[1],
      data: dataUrl[2],
      ...(dimension ? { dimension } : {}),
    };
  }
  return { url, ...(dimension ? { dimension } : {}) };
}

export function contentToTextAndImages(
  content: unknown,
  role: string,
): { text: string; images: CursorImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (content === null || content === undefined) return { text: "", images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };

  const parts: string[] = [];
  const images: CursorImage[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      parts.push(JSON.stringify(part));
      continue;
    }
    const type = part.type;
    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    } else if (
      type === "image_url" &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === "string"
    ) {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "input_image" && typeof part.image_url === "string") {
      images.push(imageFromUrl(part.image_url));
      parts.push("[image]");
    } else if (
      type === "input_image" &&
      isRecord(part.image_url) &&
      typeof part.image_url.url === "string"
    ) {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "tool_result" || type === "function_call_output") {
      parts.push(`${role} ${String(type)}: ${JSON.stringify(part)}`);
    } else {
      parts.push(JSON.stringify(part));
    }
  }
  return { text: parts.join("\n"), images };
}

export function toolCallContextFromMessages(
  messages: unknown[],
): ToolCallContext | undefined {
  const workingDirectory = messages
    .map((message) => (isRecord(message) ? contentToPlainText(message.content) : ""))
    .map(workingDirectoryFromText)
    .find(Boolean);
  return workingDirectory ? { workingDirectory } : undefined;
}

export function toolCallContextFromResponseInput(
  input: unknown,
  instructions: unknown,
): ToolCallContext | undefined {
  const texts: string[] = [];
  if (typeof instructions === "string") texts.push(instructions);
  for (const item of responseInputArray(input)) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (isRecord(item)) {
      texts.push(contentToPlainText(item.content));
      if (typeof item.instructions === "string") texts.push(item.instructions);
    }
  }
  const workingDirectory = texts.map(workingDirectoryFromText).find(Boolean);
  return workingDirectory ? { workingDirectory } : undefined;
}

export function workingDirectoryFromText(text: string): string | undefined {
  for (const pattern of [
    /^\s*Working directory:\s*(.+)$/im,
    /^\s*Current working directory:\s*(.+)$/im,
    /^\s*Workspace root folder:\s*(.+)$/im,
    /^\s*Workspace root:\s*(.+)$/im,
  ]) {
    const match = pattern.exec(text);
    const value = sanitizeContextPath(match?.[1]);
    if (value) return value;
  }
  return undefined;
}

export function responseInputArray(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}
