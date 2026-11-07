import { describe, expect, it } from "vitest";
import { prepareResponsesRequest } from "../../src/protocol/prepare.js";

describe("prepareResponsesRequest Codex IDE workspace", () => {
  it("extracts working directory from developer input_text blocks", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: [
                  "Environment:",
                  "  Working directory: /home/rafael/dev-rafael/ativeplus",
                ].join("\n"),
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "describe this repository" }],
          },
        ],
        tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.toolContext).toEqual({
      workingDirectory: "/home/rafael/dev-rafael/ativeplus",
    });
  });

  it("extracts working directory from instructions input_text array", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        instructions: [
          {
            type: "input_text",
            text: [
              "Environment:",
              "  Working directory: /home/user/ativeplus",
            ].join("\n"),
          },
        ],
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "describe this repository" }],
          },
        ],
        tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.toolContext).toEqual({
      workingDirectory: "/home/user/ativeplus",
    });
  });

  it("extracts working directory from instructions and nested input", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        instructions: [
          "Environment:",
          "  Working directory: /home/user/ativeplus",
          "  Workspace root folder: /home/user/ativeplus",
        ].join("\n"),
        input: [{ role: "user", content: "describe this repository" }],
        tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.toolContext).toEqual({
      workingDirectory: "/home/user/ativeplus",
    });
  });
});
