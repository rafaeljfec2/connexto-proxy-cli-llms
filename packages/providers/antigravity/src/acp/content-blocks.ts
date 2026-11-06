import type { ContentBlock } from "./types.js";

export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

export function imageBlock(mimeType: string, base64Data: string): ContentBlock {
  return { type: "image", mimeType, data: base64Data };
}

export function textPrompt(text: string): readonly ContentBlock[] {
  return [textBlock(text)];
}

export function imageAndTextPrompt(
  mimeType: string,
  base64Data: string,
  text: string,
): readonly ContentBlock[] {
  return [textBlock(text), imageBlock(mimeType, base64Data)];
}
