import { describe, expect, it } from "vitest";
import {
  responseObject,
  toolCallRetryHint,
  toOpenAiToolCalls,
} from "../../src/openai.js";

describe("OpenAI compatibility adapter - tool-resolution-advanced", () => {
  it("repairs swapped SDK glob pattern and path values", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
            },
            required: ["pattern"],
          },
        },
      ],
      toolCalls: [
        {
          name: "glob",
          arguments: { targetDirectory: "**/*.tsx", globPattern: "/tmp/project" },
        },
      ],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*.tsx",
      path: "/tmp/project",
    });
  });

  it("repairs swapped SDK glob values when the search root is current directory", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
            },
            required: ["pattern"],
          },
        },
      ],
      toolCalls: [
        { name: "glob", arguments: { targetDirectory: "**/*", globPattern: "." } },
      ],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*",
      path: ".",
    });
  });

  it("defaults empty SDK glob calls to a valid OpenCode workspace glob", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
          },
        },
      ],
      toolCalls: [{ name: "glob", arguments: {} }],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ pattern: "**/*" });
  });

  it("does not emit schema-invalid file tool calls", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "write",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
          },
        },
      ],
      toolCalls: [{ name: "write", arguments: { path: "src/App.tsx" } }],
    });

    expect(toolCalls).toEqual([]);
  });

  it("explains schema-invalid file tool call retries with required client arguments", () => {
    const tools = [
      {
        name: "write",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            filePath: { type: "string" },
            content: { type: "string" },
          },
          required: ["filePath", "content"],
        },
      },
    ];

    const hint = toolCallRetryHint({
      tools,
      toolCall: { name: "write", arguments: { path: "src/App.tsx" } },
    });

    expect(hint).toContain("SDK write mapped to client write");
    expect(hint).toContain("Normalized arguments");
    expect(hint).toContain("filePath");
    expect(hint).toContain("content:string");
  });

  it("maps SDK directory-only glob calls to a valid OpenCode glob", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
            },
            required: ["pattern"],
          },
        },
      ],
      toolCalls: [{ name: "glob", arguments: { targetDirectory: "src" } }],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*",
      path: "src",
    });
  });

  it("fills a required glob path with the harness workspace root", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
            },
            required: ["pattern", "path"],
          },
        },
      ],
      toolCalls: [{ name: "glob", arguments: { globPattern: "**/*.tsx" } }],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*.tsx",
      path: ".",
    });
  });

  it("maps SDK glob calls to query-based file search schemas", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "file_search",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              basePath: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
      toolCalls: [
        {
          name: "glob",
          arguments: { globPattern: "**/*.tsx", targetDirectory: "src" },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("file_search");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      query: "**/*.tsx",
      basePath: "src",
    });
  });

  it("maps SDK ls calls to query-based file search schemas", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "find_files",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              filePattern: { type: "string" },
              root: { type: "string" },
            },
            required: ["filePattern"],
          },
        },
      ],
      toolCalls: [{ name: "ls", arguments: { path: "src" } }],
    });

    expect(toolCalls[0].function.name).toBe("find_files");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      filePattern: "*",
      root: "src",
    });
  });

  it("does not map SDK glob calls to generic semantic query tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "semantic_search",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      toolCalls: [{ name: "glob", arguments: { globPattern: "**/*.tsx" } }],
    });

    expect(toolCalls).toEqual([]);
  });

  it("does not emit schema-invalid specific MCP tool calls", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "mcp__github__create_issue",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "github",
            toolName: "create_issue",
            args: { body: "Missing required title" },
          },
        },
      ],
    });

    expect(toolCalls).toEqual([]);
  });

  it("does not emit wrapper MCP calls with schema-invalid nested input", () => {
    const tools = [
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            serverName: { type: "string" },
            toolName: { type: "string" },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                file_path: { type: "string" },
                contents: { type: "string" },
              },
              required: ["file_path", "contents"],
            },
          },
          required: ["serverName", "toolName", "input"],
        },
      },
    ];
    const missingContentsCall = {
      name: "mcp",
      arguments: {
        providerIdentifier: "filesystem",
        toolName: "write_file",
        args: { file_path: "src/App.tsx" },
      },
    };

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools,
      toolCalls: [missingContentsCall],
    });
    const hint = toolCallRetryHint({ tools, toolCall: missingContentsCall });

    expect(toolCalls).toEqual([]);
    expect(hint).toContain("input.file_path:string");
    expect(hint).toContain("input.contents:string");
  });

  it("maps SDK file operations to Anthropic-style text editor schemas", () => {
    const tools = [
      {
        name: "str_replace_editor",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            path: { type: "string" },
            file_text: { type: "string" },
            old_str: { type: "string" },
            new_str: { type: "string" },
            view_range: { type: "array", items: { type: "integer" } },
          },
          required: ["command", "path"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools,
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
          },
        },
        { name: "read", arguments: { path: "src/App.tsx", offset: 10, limit: 20 } },
        {
          name: "edit",
          arguments: { path: "src/App.tsx", oldString: "Hello", newString: "Hi" },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "str_replace_editor",
      "str_replace_editor",
      "str_replace_editor",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        command: "create",
        path: "src/App.tsx",
        file_text: "export default function App() { return null }",
      },
      { command: "view", path: "src/App.tsx", view_range: [10, 29] },
      { command: "str_replace", path: "src/App.tsx", old_str: "Hello", new_str: "Hi" },
    ]);
  });

  it("maps SDK file operations to action-based compound file tools", () => {
    const tools = [
      {
        name: "file_manager",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["read", "write", "replace", "delete"] },
            path: { type: "string" },
            content: { type: "string" },
            old: { type: "string" },
            replacement: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["action", "path"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools,
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
          },
        },
        { name: "read", arguments: { path: "src/App.tsx", offset: 5, limit: 10 } },
        {
          name: "edit",
          arguments: { path: "src/App.tsx", oldString: "Hello", newString: "Hi" },
        },
        { name: "delete", arguments: { path: "src/old.tsx" } },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "file_manager",
      "file_manager",
      "file_manager",
      "file_manager",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        action: "write",
        path: "src/App.tsx",
        content: "export default function App() { return null }",
      },
      { action: "read", path: "src/App.tsx", offset: 5, limit: 10 },
      { action: "replace", path: "src/App.tsx", old: "Hello", replacement: "Hi" },
      { action: "delete", path: "src/old.tsx" },
    ]);
  });

  it("maps SDK edit streamContent calls to write-compatible tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "write_file",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              filePath: { type: "string" },
              content: { type: "string" },
            },
            required: ["filePath", "content"],
          },
        },
      ],
      toolCalls: [
        {
          name: "edit",
          arguments: {
            path: "src/App.tsx",
            streamContent: "export default function App() { return null }",
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("write_file");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      filePath: "src/App.tsx",
      content: "export default function App() { return null }",
    });
  });

  it("maps SDK calls into wrapper object tool schemas", () => {
    const tools = [
      {
        name: "wrapped_bash",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                command: { type: "string" },
                workdir: { type: "string" },
              },
              required: ["command"],
            },
          },
          required: ["input"],
        },
      },
      {
        name: "wrapped_files",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                action: {
                  type: "string",
                  enum: ["read", "write", "replace", "delete"],
                },
                path: { type: "string" },
                content: { type: "string" },
                old: { type: "string" },
                replacement: { type: "string" },
              },
              required: ["action", "path"],
            },
          },
          required: ["input"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools,
      toolCalls: [
        {
          name: "shell",
          arguments: { command: "npm test", workingDirectory: "/tmp/app" },
        },
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
          },
        },
        {
          name: "edit",
          arguments: { path: "src/App.tsx", oldString: "Hello", newString: "Hi" },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "wrapped_bash",
      "wrapped_files",
      "wrapped_files",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { input: { command: "npm test", workdir: "/tmp/app" } },
      {
        input: {
          action: "write",
          path: "src/App.tsx",
          content: "export default function App() { return null }",
        },
      },
      {
        input: {
          action: "replace",
          path: "src/App.tsx",
          old: "Hello",
          replacement: "Hi",
        },
      },
    ]);
  });

  it("maps SDK patchContent edits to apply-patch style tools", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/App.tsx",
      "@@",
      "-return null",
      "+return <main />",
      "*** End Patch",
    ].join("\n");
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "apply_patch",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              patch: { type: "string" },
              path: { type: "string" },
            },
            required: ["patch"],
          },
        },
      ],
      toolCalls: [
        { name: "edit", arguments: { path: "src/App.tsx", patchContent: patch } },
      ],
    });

    expect(toolCalls[0].function.name).toBe("apply_patch");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      path: "src/App.tsx",
      patch,
    });
  });

  it("maps SDK patchContent edits without a separate path to patch-only tools", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/App.tsx",
      "@@",
      "-return null",
      "+return <main />",
      "*** End Patch",
    ].join("\n");
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "apply_patch",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              patch: { type: "string" },
            },
            required: ["patch"],
          },
        },
      ],
      toolCalls: [{ name: "edit", arguments: { patchContent: patch } }],
    });

    expect(toolCalls[0].function.name).toBe("apply_patch");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ patch });
    expect(
      responseObject({
        id: "resp_patch",
        created: 1,
        model: "composer-2.5",
        text: "",
        toolCalls,
        promptChars: 20,
      }).output,
    ).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: toolCalls[0].id,
        name: "apply_patch",
        arguments: JSON.stringify({ patch }),
      }),
    ]);
  });

  it("maps SDK file operations to apply-patch style tools", () => {
    const tools = [
      {
        name: "apply_patch",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            patch: { type: "string" },
            path: { type: "string" },
          },
          required: ["patch"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools,
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() {\n  return null\n}\n",
          },
        },
        {
          name: "edit",
          arguments: {
            path: "src/App.tsx",
            oldString: "return null",
            newString: "return <main />",
          },
        },
        { name: "delete", arguments: { path: "src/old.tsx" } },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "apply_patch",
      "apply_patch",
      "apply_patch",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        path: "src/App.tsx",
        patch: [
          "*** Begin Patch",
          "*** Add File: src/App.tsx",
          "+export default function App() {",
          "+  return null",
          "+}",
          "*** End Patch",
        ].join("\n"),
      },
      {
        path: "src/App.tsx",
        patch: [
          "*** Begin Patch",
          "*** Update File: src/App.tsx",
          "@@",
          "-return null",
          "+return <main />",
          "*** End Patch",
        ].join("\n"),
      },
      {
        path: "src/old.tsx",
        patch: [
          "*** Begin Patch",
          "*** Delete File: src/old.tsx",
          "*** End Patch",
        ].join("\n"),
      },
    ]);
  });

  it("does not emit SDK-native tool names outside the advertised client tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "notify",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      toolCalls: [{ name: "shell", arguments: { command: "pwd" } }],
    });

    expect(toolCalls).toEqual([]);
  });

  it("keeps raw SDK tool calls only when the client did not provide a tool inventory", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [],
      toolCalls: [{ name: "shell", arguments: { command: "pwd" } }],
    });

    expect(toolCalls[0].function.name).toBe("shell");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ command: "pwd" });
  });
});
