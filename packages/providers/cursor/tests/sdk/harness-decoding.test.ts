import { describe, expect, it } from "vitest";
import { cursorSdkTestExports } from "../../src/cursor-sdk.js";
import {
  protoMessage,
  protoMessageField,
  protoStringField,
  protoValueMapEntry,
  protoStringValue,
  protoBoolValue,
  fields as decodeTestFields,
  bytesField as dataField,
  type TestField as ProtoField,
} from "../engine/helpers.js";

function decodeFields(bytes: Uint8Array): ProtoField[] {
  return decodeTestFields(bytes);
}

function stringField(fields: ProtoField[], no: number): string | undefined {
  const field = fields.find((f) => f.no === no);
  return field?.value instanceof Uint8Array
    ? new TextDecoder().decode(field.value)
    : undefined;
}

describe("Cursor SDK Harness Decoding", () => {
  it("decodes SDK MCP tool args maps", () => {
    const mcpArgs = protoMessage([
      protoStringField(1, "write_file"),
      protoMessageField(
        2,
        protoValueMapEntry("file_path", protoStringValue("src/App.tsx")),
      ),
      protoMessageField(2, protoValueMapEntry("overwrite", protoBoolValue(true))),
      protoStringField(3, "call-mcp-1"),
      protoStringField(4, "filesystem"),
      protoStringField(5, "write_file"),
    ]);
    const mcpTool = protoMessage([protoMessageField(1, mcpArgs)]);
    const toolCallUpdate = protoMessage([
      protoMessageField(2, protoMessage([protoMessageField(15, mcpTool)])),
    ]);
    const interaction = protoMessage([protoMessageField(2, toolCallUpdate)]);
    const frame = protoMessage([protoMessageField(1, interaction)]);

    const event = cursorSdkTestExports
      .decodeLocalAgentServerFrame(frame)
      .find((item) => item.type === "tool_call");

    expect(event).toMatchObject({
      type: "tool_call",
      toolCall: {
        name: "mcp",
        arguments: {
          name: "write_file",
          providerIdentifier: "filesystem",
          toolName: "write_file",
          toolCallId: "call-mcp-1",
          args: {
            file_path: "src/App.tsx",
            overwrite: true,
          },
        },
      },
    });
  });

  it("encodes the harness working directory in SDK request context results", () => {
    const context = cursorSdkTestExports.encodeAgentClientRequestContextResult(
      { id: 42, execId: "exec-1" },
      { workingDirectory: "/tmp/project" },
    );
    const execMessage = dataField(decodeFields(context), 2);
    const result = dataField(decodeFields(execMessage), 10);
    const success = dataField(decodeFields(result), 1);
    const requestContext = dataField(decodeFields(success), 1);
    const env = dataField(decodeFields(requestContext), 4);
    const envFields = decodeFields(env);

    expect(stringField(envFields, 2)).toBe("/tmp/project");
    expect(stringField(envFields, 11)).toBe("/tmp/project");
    expect(stringField(envFields, 21)).toBe("/tmp/project");
  });

  it("builds a hard retry prompt when a tool-required SDK turn returns prose", () => {
    const prompt = cursorSdkTestExports.retryPromptAfterMissingTool("Original prompt");

    expect(prompt).toContain("Original prompt");
    expect(prompt).toContain("TOOL CALL RETRY");
    expect(prompt).toContain("attempt 2 of 3");
    expect(prompt).toContain(
      "The next response is invalid unless it contains a tool_call.",
    );
    expect(prompt).toContain("Do not answer in prose");
    expect(prompt).toContain("Emit exactly one SDK tool call");
  });

  it("builds a retry prompt when the SDK chooses an unmapped tool", () => {
    const prompt = cursorSdkTestExports.retryPromptAfterUnsupportedTool(
      "Original prompt",
      {
        name: "shell",
        arguments: { command: "pwd" },
      },
      "Required client arguments: command:string, description:string.",
    );

    expect(prompt).toContain("Original prompt");
    expect(prompt).toContain("shell");
    expect(prompt).toContain("could not be mapped");
    expect(prompt).toContain("Required client arguments");
    expect(prompt).toContain("mappable tool_call");
    expect(prompt).toContain("allowed OpenCode tool inventory");
  });
});
