import { protoField, protoMessage } from "../engine/connect-proto.js";
import { decodeUtf8 } from "../engine/utils.js";
import type { ProtobufField } from "./types.js";
import { AGENT_MODE_AGENT } from "./types.js";

const EMPTY_FIELD = new Uint8Array(0);

export function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoField(fieldNumber, 2, value);
}

export function protoStringField(
  fieldNumber: number,
  value: string | undefined,
): Uint8Array {
  if (value === undefined) return EMPTY_FIELD;
  return protoField(fieldNumber, 2, value);
}

export function protoVarintField(
  fieldNumber: number,
  value: number | boolean | undefined,
): Uint8Array {
  if (value === undefined) return EMPTY_FIELD;
  return protoField(fieldNumber, 0, typeof value === "boolean" ? Number(value) : value);
}

export function bytesField(
  fields: ProtobufField[],
  fieldNumber: number,
): Uint8Array | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && item.value instanceof Uint8Array,
  );
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

export function stringField(
  fields: ProtobufField[],
  fieldNumber: number,
): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? decodeUtf8(bytes) : undefined;
}

export function stringFields(
  fields: ProtobufField[],
  fieldNumber: number,
): string[] | undefined {
  const values = fields
    .filter((item) => item.no === fieldNumber && item.value instanceof Uint8Array)
    .map((item) => decodeUtf8(item.value as Uint8Array));
  return values.length ? values : undefined;
}

export function numberField(
  fields: ProtobufField[],
  fieldNumber: number,
): number | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && typeof item.value === "number",
  );
  return typeof field?.value === "number" ? field.value : undefined;
}

export function booleanField(
  fields: ProtobufField[],
  fieldNumber: number,
): boolean | undefined {
  const value = numberField(fields, fieldNumber);
  return value === undefined ? undefined : value !== 0;
}

export function encodeAgentClientRunRequest(input: {
  agentId: string;
  messageId: string;
  modelId: string;
  prompt: string;
}): Uint8Array {
  const userMessage = protoMessage([
    protoStringField(1, input.prompt),
    protoStringField(2, input.messageId),
    protoVarintField(4, AGENT_MODE_AGENT),
  ]);
  const userMessageAction = protoMessage([protoMessageField(1, userMessage)]);
  const conversationAction = protoMessage([protoMessageField(1, userMessageAction)]);
  const modelDetails = protoMessage([
    protoStringField(1, input.modelId),
    protoStringField(3, input.modelId),
    protoStringField(4, input.modelId),
  ]);
  const requestedModel = protoMessage([protoStringField(1, input.modelId)]);
  const runRequest = protoMessage([
    protoMessageField(1, protoMessage([])),
    protoMessageField(2, conversationAction),
    protoMessageField(3, modelDetails),
    protoMessageField(4, protoMessage([])),
    protoStringField(5, input.agentId),
    protoStringField(13, "sdk"),
    protoMessageField(9, requestedModel),
    protoVarintField(19, 1),
  ]);
  return protoMessage([protoMessageField(1, runRequest)]);
}

export function encodeAgentClientRequestContextResult(
  input: { id: number; execId?: string },
  options: { workingDirectory?: string } = {},
): Uint8Array {
  const workingDirectory = sdkWorkingDirectory(options.workingDirectory);
  const env = protoMessage([
    protoStringField(1, "Cloudflare Worker"),
    protoStringField(2, workingDirectory),
    protoStringField(3, "sh"),
    protoVarintField(5, false),
    protoStringField(10, "UTC"),
    protoStringField(11, workingDirectory),
    protoStringField(21, workingDirectory),
  ]);
  const requestContext = protoMessage([
    protoMessageField(4, env),
    protoVarintField(17, false),
    protoVarintField(24, false),
    protoVarintField(32, true),
    protoVarintField(33, true),
    protoVarintField(35, false),
    protoVarintField(36, true),
    protoVarintField(39, true),
    protoVarintField(40, true),
    protoVarintField(41, true),
    protoVarintField(42, true),
    protoVarintField(43, true),
    protoVarintField(44, true),
    protoVarintField(45, true),
  ]);
  const success = protoMessage([protoMessageField(1, requestContext)]);
  const result = protoMessage([protoMessageField(1, success)]);
  const execClientMessage = protoMessage([
    protoVarintField(1, input.id),
    protoStringField(15, input.execId),
    protoMessageField(10, result),
  ]);
  return protoMessage([protoMessageField(2, execClientMessage)]);
}

export function sdkWorkingDirectory(value: string | undefined): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  )
    return ".";
  return trimmed;
}
