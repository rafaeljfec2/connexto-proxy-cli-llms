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

  const codexXmlContext = (cwd: string, extra = "") =>
    [
      "<environment_context>",
      `  <cwd>${cwd}</cwd>`,
      "  <filesystem>",
      "    <workspace_roots>",
      `      <root>${cwd}</root>`,
      "    </workspace_roots>",
      "  </filesystem>",
      "</environment_context>",
      extra,
    ]
      .filter(Boolean)
      .join("\n");

  it("extracts working directory from Codex environment_context cwd XML", () => {
    const project = "/home/rafael/dev-francys/ativeplus";
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: codexXmlContext(project) }],
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

    expect(prepared.toolContext).toEqual({ workingDirectory: project });
  });

  it("extracts working directory from workspace_roots root when cwd tag is absent", () => {
    const project = "/home/rafael/dev-francys/ativeplus";
    const text = [
      "<environment_context>",
      "  <filesystem>",
      "    <workspace_roots>",
      `      <root>${project}</root>`,
      "    </workspace_roots>",
      "  </filesystem>",
      "</environment_context>",
    ].join("\n");

    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text }],
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

    expect(prepared.toolContext).toEqual({ workingDirectory: project });
  });

  it("prefers Codex workspace cwd over Active file pointing at a config file", () => {
    const project = "/home/rafael/dev-francys/ativeplus";
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
                  codexXmlContext(project),
                  "# Context from my IDE setup",
                  "## Active file: /home/rafael/.codex/config.toml",
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

    expect(prepared.toolContext).toEqual({ workingDirectory: project });
  });

  it("uses parent directory when only Active file is present", () => {
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
                  "# Context from my IDE setup",
                  "## Active file: /home/rafael/dev-francys/ativeplus/src/index.ts",
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
      workingDirectory: "/home/rafael/dev-francys/ativeplus/src",
    });
  });
});
