import {
  HttpError,
  isRecord,
  type CursorPrompt,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import type { EncodedCursorImage, ProtobufField } from "./types.js";
import { concatBytes, decodeUtf8 } from "./utils.js";
import { decodeBinaryToolCall } from "./filters.js";
import { encodeImageProto } from "./images.js";

export function protoMessage(parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts);
}

export function protoField(
  fieldNumber: number,
  wireType: 0 | 2,
  value: string | number | Uint8Array,
): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | wireType);
  if (wireType === 0) return concatBytes(tag, encodeVarint(value as number));
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : encodeVarint(value);
  return concatBytes(tag, encodeVarint(bytes.length), bytes);
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`encodeVarint: expected non-negative integer, got ${value}`);
  }
  if (value >= 2 ** 32) {
    throw new Error(`encodeVarint: value ${value} exceeds 32-bit unsigned limit`);
  }
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

export function decodeProtobufFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const no = tag.value >> 3;
    const wt = tag.value & 7;
    if (wt === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      fields.push({ no, wt, value: value.value });
    } else if (wt === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      fields.push({ no, wt, value: bytes.slice(offset, offset + length.value) });
      offset += length.value;
    } else if (wt === 1) {
      const end = offset + 8;
      if (end > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      fields.push({ no, wt, value: view.getFloat64(0, true) });
      offset = end;
    } else if (wt === 5) {
      const end = offset + 4;
      if (end > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
      fields.push({ no, wt, value: view.getUint32(0, true) });
      offset = end;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wt}`);
    }
  }
  return fields;
}

export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cur = offset;
  while (cur < bytes.length) {
    const byte = bytes[cur++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: cur };
    shift += 7;
  }
  throw new Error("Unexpected end of protobuf varint");
}

export function encodeConnectFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export async function* parseConnectProtoFrames(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer = concatBytes(buffer, value);
      for (;;) {
        if (buffer.length < 5) break;
        const flags = buffer[0];
        const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(
          0,
          false,
        );
        if (buffer.length < 5 + length) break;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if ((flags & 1) === 1) {
          throw new HttpError(
            "Cursor returned a compressed Connect frame that this Worker cannot decode.",
            502,
            "cursor_stream_error",
          );
        }
        if ((flags & 2) === 2) {
          handleEndStreamFrame(payload);
          continue;
        }
        yield payload;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function handleEndStreamFrame(
  payload: Uint8Array,
  fallbackMessage = "Cursor stream failed",
): void {
  if (!payload.length) return;
  const text = decodeUtf8(payload).trim();
  if (!text || text === "{}") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message =
        cursorStreamErrorMessage(parsed.error) ??
        (typeof parsed.error.message === "string"
          ? parsed.error.message
          : fallbackMessage);
      throw new HttpError(message, 502, "cursor_stream_error");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
}

export function decodeCursorChatFrame(
  payload: Uint8Array,
):
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCall?: CursorToolCall }
  | { type: "ignore" }
  | { type: "error"; message: string } {
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1) {
        return {
          type: "tool_call",
          ...(field.value instanceof Uint8Array
            ? decodeBinaryToolCall(field.value)
            : {}),
        };
      }
      if (field.no !== 2 || field.wt !== 2 || !(field.value instanceof Uint8Array))
        continue;
      let text = "";
      let thinking = "";
      for (const inner of decodeProtobufFields(field.value)) {
        if (inner.no === 1 && inner.wt === 2 && inner.value instanceof Uint8Array)
          text += decodeUtf8(inner.value);
        if (inner.no === 25 && inner.wt === 2 && inner.value instanceof Uint8Array) {
          for (const thinkingField of decodeProtobufFields(inner.value)) {
            if (
              thinkingField.no === 1 &&
              thinkingField.wt === 2 &&
              thinkingField.value instanceof Uint8Array
            ) {
              thinking += decodeUtf8(thinkingField.value);
            }
          }
        }
      }
      if (text) return { type: "text", text };
      if (thinking) return { type: "thinking", text: thinking };
    }
    return { type: "ignore" };
  } catch (error) {
    return {
      type: "error",
      message:
        error instanceof Error ? error.message : "Failed to decode Cursor stream",
    };
  }
}

export function encodeCursorChatRequest(input: {
  prompt: CursorPrompt;
  images?: EncodedCursorImage[];
  model: string;
  requestId: string;
  conversationId: string;
  messageId: string;
}): Uint8Array {
  const messageId = input.messageId;
  const composerMode = input.prompt.mode === "agent" ? "Agent" : "Ask";
  const imageFields = (input.images ?? []).map((image) =>
    protoField(10, 2, encodeImageProto(image)),
  );
  const userMessage = protoMessage([
    protoField(1, 2, input.prompt.text),
    protoField(2, 0, 1),
    ...imageFields,
    protoField(13, 2, messageId),
    protoField(47, 0, 1),
  ]);
  const model = protoMessage([
    protoField(1, 2, input.model),
    protoField(4, 2, new Uint8Array(0)),
  ]);
  const cursorSetting = protoMessage([
    protoField(1, 2, "cursor\\aisettings"),
    protoField(3, 2, new Uint8Array(0)),
    protoField(
      6,
      2,
      protoMessage([
        protoField(1, 2, new Uint8Array(0)),
        protoField(2, 2, new Uint8Array(0)),
      ]),
    ),
    protoField(8, 0, 1),
    protoField(9, 0, 1),
  ]);
  const metadata = protoMessage([
    protoField(1, 2, "linux"),
    protoField(2, 2, "x64"),
    protoField(3, 2, "unknown"),
    protoField(4, 2, "composer-api"),
    protoField(5, 2, new Date().toISOString()),
  ]);
  const messageIdRecord = protoMessage([
    protoField(1, 2, messageId),
    protoField(3, 0, 1),
  ]);
  const request = protoMessage([
    protoField(1, 2, userMessage),
    protoField(2, 0, 1),
    protoField(3, 2, new Uint8Array(0)),
    protoField(4, 0, 1),
    protoField(5, 2, model),
    protoField(8, 2, ""),
    protoField(13, 0, 1),
    protoField(15, 2, cursorSetting),
    protoField(19, 0, 1),
    protoField(23, 2, input.conversationId),
    protoField(26, 2, metadata),
    protoField(27, 0, 0),
    protoField(30, 2, messageIdRecord),
    protoField(35, 0, 0),
    protoField(38, 0, 0),
    protoField(46, 0, 1),
    protoField(47, 2, ""),
    protoField(48, 0, 0),
    protoField(49, 0, 0),
    protoField(51, 0, 0),
    protoField(53, 0, 1),
    protoField(54, 2, composerMode),
  ]);
  return protoMessage([protoField(1, 2, request)]);
}

export function cursorStreamErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const titleAndDetail = detailFromCursorError(error);
  if (titleAndDetail) return titleAndDetail;
  return typeof error.message === "string" ? error.message : undefined;
}

export function detailFromCursorError(
  error: Record<string, unknown>,
): string | undefined {
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    if (!isRecord(detail) || !isRecord(detail.debug)) continue;
    const debugDetails = isRecord(detail.debug.details)
      ? detail.debug.details
      : undefined;
    const title = typeof debugDetails?.title === "string" ? debugDetails.title : "";
    const body = typeof debugDetails?.detail === "string" ? debugDetails.detail : "";
    const message = [title, body].filter(Boolean).join(" ");
    if (message) return message;
  }
  return undefined;
}
