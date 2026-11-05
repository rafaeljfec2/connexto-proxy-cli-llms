export type TestField = { no: number; wt: number; value: number | Uint8Array };

export function chatResponseText(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(1, text)]))]);
}

export function chatResponseThinking(text: string): Uint8Array {
  return protoMessage([
    protoField(2, protoMessage([protoField(25, protoMessage([protoField(1, text)]))])),
  ]);
}

export function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export function cursorError(title: string, detail: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      error: {
        code: "resource_exhausted",
        message: "Error",
        details: [{ debug: { details: { title, detail } } }],
      },
    }),
  );
}

export function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function protoField(
  fieldNumber: number,
  value: string | Uint8Array,
): Uint8Array {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return protoMessage([varint((fieldNumber << 3) | 2), varint(data.length), data]);
}

export function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

export function fields(data: Uint8Array): TestField[] {
  const output: TestField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    offset = tag.offset;
    const no = tag.value >> 3;
    const wt = tag.value & 7;
    if (wt === 0) {
      const value = readVarint(data, offset);
      offset = value.offset;
      output.push({ no, wt, value: value.value });
    } else if (wt === 2) {
      const length = readVarint(data, offset);
      offset = length.offset;
      output.push({ no, wt, value: data.slice(offset, offset + length.value) });
      offset += length.value;
    } else {
      throw new Error(`Unsupported wire type ${wt}`);
    }
  }
  return output;
}

export function bytesField(fieldList: TestField[], no: number): Uint8Array {
  const field = fieldList.find((item) => item.no === no);
  if (!field || !(field.value instanceof Uint8Array))
    throw new Error(`Missing bytes field ${no}`);
  return field.value;
}

export function numberField(fieldList: TestField[], no: number): number {
  const field = fieldList.find((item) => item.no === no);
  if (!field || typeof field.value !== "number")
    throw new Error(`Missing number field ${no}`);
  return field.value;
}

export function readVarint(
  data: Uint8Array,
  offset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Unexpected end of varint");
}

export function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoField(fieldNumber, value);
}

export function protoStringField(fieldNumber: number, value: string): Uint8Array {
  return protoMessageField(fieldNumber, new TextEncoder().encode(value));
}

export function protoValueMapEntry(key: string, value: Uint8Array): Uint8Array {
  return protoMessage([protoStringField(1, key), protoMessageField(2, value)]);
}

export function protoStringValue(value: string): Uint8Array {
  return protoMessage([protoStringField(3, value)]);
}

export function protoBoolValue(value: boolean): Uint8Array {
  return protoMessage([varint(4 << 3), varint(value ? 1 : 0)]);
}
