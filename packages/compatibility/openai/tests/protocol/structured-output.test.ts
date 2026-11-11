import { describe, expect, it } from "vitest";
import {
  appendJsonConstraint,
  enforceStructuredOutputFormat,
  HttpError,
  prepareResponsesRequest,
  unwrapMarkdownJsonFence,
} from "../../src/index.js";

describe("structured output constraints and validation", () => {
  const metaSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      language: { type: "string" },
      type: { type: "string" },
    },
    required: ["name", "language", "type"],
    additionalProperties: false,
  };

  it("instructs models to avoid Markdown code fences for json_schema strict", () => {
    const constraints: string[] = [];
    appendJsonConstraint(constraints, {
      type: "json_schema",
      name: "connexto_meta",
      strict: true,
      schema: metaSchema,
    });

    expect(constraints).toHaveLength(1);
    expect(constraints[0]).toContain("NO Markdown code fences");
    expect(constraints[0]).toContain("Strictly satisfy all required fields");
    expect(constraints[0]).toContain("additionalProperties");

    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: "Return metadata",
        text: {
          format: {
            type: "json_schema",
            name: "connexto_meta",
            strict: true,
            schema: metaSchema,
          },
        },
      },
      { id: "composer-2.5" },
    );
    expect(prepared.prompt.text).toContain("NO Markdown code fences");
  });

  it("unwraps a single outer Markdown json fence without touching raw JSON", () => {
    const raw = '{"name":"Connexto AI-Hub","language":"Go","type":"API"}';
    expect(unwrapMarkdownJsonFence(raw)).toBe(raw);
    expect(unwrapMarkdownJsonFence(`\`\`\`json\n${raw}\n\`\`\``)).toBe(raw);
    expect(unwrapMarkdownJsonFence(`\`\`\`\n${raw}\n\`\`\``)).toBe(raw);
    expect(
      unwrapMarkdownJsonFence(`Here is the JSON:\n\`\`\`json\n${raw}\n\`\`\``),
    ).toContain("Here is the JSON:");
  });

  it("passes valid raw or cleanly fenced JSON matching strict schema", () => {
    const format = {
      type: "json_schema",
      name: "connexto_meta",
      strict: true,
      schema: metaSchema,
    };
    const raw = '{"name":"Connexto AI-Hub","language":"Go","type":"API"}';

    expect(enforceStructuredOutputFormat(raw, format)).toBe(raw);
    expect(enforceStructuredOutputFormat(`\`\`\`json\n${raw}\n\`\`\``, format)).toBe(
      raw,
    );
  });

  it("rejects non-JSON, prose-wrapped output, missing required keys, and extra keys", () => {
    const format = {
      type: "json_schema",
      name: "connexto_meta",
      strict: true,
      schema: metaSchema,
    };

    expect(() => enforceStructuredOutputFormat("not json", format)).toThrow(HttpError);
    expect(() =>
      enforceStructuredOutputFormat(
        'Here you go:\n```json\n{"name":"A","language":"Go","type":"API"}\n```',
        format,
      ),
    ).toThrow(HttpError);
    expect(() =>
      enforceStructuredOutputFormat('{"name":"A","language":"Go"}', format),
    ).toThrow(/required/);
    expect(() =>
      enforceStructuredOutputFormat(
        '{"name":"A","language":"Go","type":"API","extra":1}',
        format,
      ),
    ).toThrow(/not allowed/);
    expect(() =>
      enforceStructuredOutputFormat(
        '{"name":123,"language":"Go","type":"API"}',
        format,
      ),
    ).toThrow(/must match type string/);
  });

  it("enforces json_object to be a plain JSON object", () => {
    const format = { type: "json_object" };
    expect(enforceStructuredOutputFormat('```json\n{"ok":true}\n```', format)).toBe(
      '{"ok":true}',
    );
    expect(() => enforceStructuredOutputFormat("[1,2,3]", format)).toThrow(HttpError);
  });

  it("uses own-property checks so prototype keys cannot bypass strict schema validation", () => {
    const formatWithProtoReq = {
      type: "json_schema",
      name: "proto_req",
      strict: true,
      schema: {
        type: "object",
        properties: { toString: { type: "string" } },
        required: ["toString"],
        additionalProperties: false,
      },
    };
    expect(() => enforceStructuredOutputFormat("{}", formatWithProtoReq)).toThrow(
      /toString is required/,
    );

    const formatStrictProps = {
      type: "json_schema",
      name: "strict_props",
      strict: true,
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    };
    expect(() =>
      enforceStructuredOutputFormat(
        '{"name":"ok","constructor":"extra"}',
        formatStrictProps,
      ),
    ).toThrow(/constructor is not allowed/);
  });
});
