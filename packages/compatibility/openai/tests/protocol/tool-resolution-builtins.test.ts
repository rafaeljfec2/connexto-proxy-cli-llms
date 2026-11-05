import { describe, expect, it } from "vitest";
import { prepareOpencodeSdkChatRequest, toOpenAiToolCalls } from "../../src/openai.js";

describe("OpenAI compatibility adapter - tool-resolution-builtins", () => {
  it("feeds OpenCode server tool results back as completed SDK MCP calls", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "Use the filesystem write_file MCP tool." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_mcp",
                type: "function",
                function: {
                  name: "mcp__filesystem__write_file",
                  arguments: JSON.stringify({
                    file_path: "src/App.tsx",
                    contents: "export default function App() { return null }",
                  }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_mcp",
            name: "mcp__filesystem__write_file",
            content: '{"content":"ok"}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__filesystem__write_file",
              parameters: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  contents: { type: "string" },
                },
                required: ["file_path", "contents"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("mcp");
    expect(feedback.args).toEqual({
      providerIdentifier: "filesystem",
      toolName: "write_file",
      args: {
        file_path: "src/App.tsx",
        contents: "export default function App() { return null }",
      },
    });
    expect(feedback.result).toEqual({ status: "success", value: { content: "ok" } });
  });

  it("feeds single-word client tool results back as completed synthetic SDK MCP calls", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "Use the webfetch tool." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_webfetch",
                type: "function",
                function: {
                  name: "webfetch",
                  arguments: JSON.stringify({
                    url: "https://example.com",
                    format: "markdown",
                  }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_webfetch",
            name: "webfetch",
            content: '{"content":"ok"}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "webfetch",
              parameters: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  format: { type: "string" },
                },
                required: ["url"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("mcp");
    expect(feedback.args).toEqual({
      providerIdentifier: "client",
      toolName: "webfetch",
      args: {
        url: "https://example.com",
        format: "markdown",
      },
    });
    expect(feedback.result).toEqual({ status: "success", value: { content: "ok" } });
  });

  it("feeds live OpenCode build tool results back with SDK-compatible names and arguments", () => {
    const fileText = "export default function App() { return null }";
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "build a todo app" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    filePath: "/tmp/project/src/App.tsx",
                    content: fileText,
                  }),
                },
              },
              {
                id: "call_read",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({
                    filePath: "/tmp/project/src/App.tsx",
                    offset: 5,
                    limit: 20,
                  }),
                },
              },
              {
                id: "call_edit",
                type: "function",
                function: {
                  name: "edit",
                  arguments: JSON.stringify({
                    filePath: "/tmp/project/src/App.tsx",
                    oldString: "return null",
                    newString: "return <main />",
                  }),
                },
              },
              {
                id: "call_glob",
                type: "function",
                function: {
                  name: "glob",
                  arguments: JSON.stringify({
                    pattern: "**/*.tsx",
                    path: "/tmp/project/src",
                  }),
                },
              },
              {
                id: "call_todo",
                type: "function",
                function: {
                  name: "todowrite",
                  arguments: JSON.stringify({
                    todos: [
                      { content: "Build app", status: "in_progress", priority: "high" },
                    ],
                  }),
                },
              },
              {
                id: "call_task",
                type: "function",
                function: {
                  name: "task",
                  arguments: JSON.stringify({
                    description: "Inspect app",
                    prompt: "Find the app entry point",
                    subagent_type: "explore",
                  }),
                },
              },
              {
                id: "call_skill",
                type: "function",
                function: {
                  name: "skill",
                  arguments: JSON.stringify({ name: "customize-opencode" }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_write", content: '{"content":"ok"}' },
          { role: "tool", tool_call_id: "call_read", content: fileText },
          {
            role: "tool",
            tool_call_id: "call_edit",
            content: '{"diff":"updated App"}',
          },
          {
            role: "tool",
            tool_call_id: "call_glob",
            content: '{"files":["src/App.tsx"]}',
          },
          { role: "tool", tool_call_id: "call_todo", content: '{"content":"ok"}' },
          {
            role: "tool",
            tool_call_id: "call_task",
            content: '{"content":"entry point is src/App.tsx"}',
          },
          { role: "tool", tool_call_id: "call_skill", content: '{"content":"loaded"}' },
        ],
        tools: [
          {
            name: "write",
            input_schema: {
              type: "object",
              properties: { filePath: { type: "string" }, content: { type: "string" } },
              required: ["filePath", "content"],
            },
          },
          {
            name: "read",
            input_schema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                offset: { type: "integer" },
                limit: { type: "integer" },
              },
              required: ["filePath"],
            },
          },
          {
            name: "edit",
            input_schema: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                oldString: { type: "string" },
                newString: { type: "string" },
              },
              required: ["filePath", "oldString", "newString"],
            },
          },
          {
            name: "glob",
            input_schema: {
              type: "object",
              properties: { pattern: { type: "string" }, path: { type: "string" } },
              required: ["pattern"],
            },
          },
          {
            name: "todowrite",
            input_schema: {
              type: "object",
              properties: { todos: { type: "array" } },
              required: ["todos"],
            },
          },
          {
            name: "task",
            input_schema: {
              type: "object",
              properties: {
                description: { type: "string" },
                prompt: { type: "string" },
                subagent_type: { type: "string" },
              },
              required: ["description", "prompt", "subagent_type"],
            },
          },
          {
            name: "skill",
            input_schema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const feedback = prepared.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL OPENCODE TOOL RESULT: ".length)));

    expect(feedback.map((item) => item.name)).toEqual([
      "write",
      "read",
      "edit",
      "glob",
      "todowrite",
      "mcp",
      "mcp",
    ]);
    expect(feedback.map((item) => item.args)).toEqual([
      { path: "/tmp/project/src/App.tsx", fileText },
      { path: "/tmp/project/src/App.tsx", offset: 5, limit: 20 },
      {
        path: "/tmp/project/src/App.tsx",
        oldString: "return null",
        newString: "return <main />",
      },
      { targetDirectory: "/tmp/project/src", globPattern: "**/*.tsx" },
      { todos: [{ content: "Build app", status: "in_progress", priority: "high" }] },
      {
        providerIdentifier: "client",
        toolName: "task",
        args: {
          description: "Inspect app",
          prompt: "Find the app entry point",
          subagent_type: "explore",
        },
      },
      {
        providerIdentifier: "client",
        toolName: "skill",
        args: { name: "customize-opencode" },
      },
    ]);
    expect(feedback[0].result.value).toMatchObject({
      path: "/tmp/project/src/App.tsx",
      linesCreated: 1,
    });
    expect(feedback[3].result.value).toMatchObject({
      files: ["src/App.tsx"],
      totalFiles: 1,
    });
  });

  it("feeds generic harness tool results back with SDK builtin names from generated call ids", () => {
    const fileText = "export default function App() { return null }";
    const tools = [
      {
        name: "workspace_file",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["read", "write", "replace", "remove"] },
            target: { type: "string" },
            body: { type: "string" },
            find: { type: "string" },
            replaceWith: { type: "string" },
          },
          required: ["action", "target"],
        },
      },
      {
        name: "run_command",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            shellCommand: { type: "string" },
            dir: { type: "string" },
          },
          required: ["shellCommand"],
        },
      },
      {
        name: "discover_files",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            includePattern: { type: "string" },
            dir: { type: "string" },
          },
          required: ["includePattern"],
        },
      },
    ];
    const generated = toOpenAiToolCalls({
      responseId: "chatcmpl_generic",
      tools,
      toolCalls: [
        { name: "write", arguments: { path: "src/App.tsx", fileText } },
        {
          name: "edit",
          arguments: {
            path: "src/App.tsx",
            oldString: "return null",
            newString: "return <main />",
          },
        },
        { name: "shell", arguments: { command: "npm test", workingDirectory: "src" } },
        {
          name: "glob",
          arguments: { globPattern: "**/*.tsx", targetDirectory: "src" },
        },
      ],
    });
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "build a todo app" },
          { role: "assistant", content: null, tool_calls: generated },
          { role: "tool", tool_call_id: generated[0].id, content: '{"content":"ok"}' },
          {
            role: "tool",
            tool_call_id: generated[1].id,
            content: '{"diff":"updated"}',
          },
          {
            role: "tool",
            tool_call_id: generated[2].id,
            content: '{"exitCode":0,"stdout":"ok","stderr":""}',
          },
          {
            role: "tool",
            tool_call_id: generated[3].id,
            content: '{"files":["src/App.tsx"]}',
          },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );

    const feedback = prepared.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL OPENCODE TOOL RESULT: ".length)));

    expect(feedback.map((item) => item.name)).toEqual([
      "write",
      "edit",
      "shell",
      "glob",
    ]);
    expect(feedback.map((item) => item.args)).toEqual([
      { path: "src/App.tsx", fileText },
      { path: "src/App.tsx", oldString: "return null", newString: "return <main />" },
      { command: "npm test", workingDirectory: "src" },
      { targetDirectory: "src", globPattern: "**/*.tsx" },
    ]);
    expect(feedback[0].result.value).toMatchObject({
      path: "src/App.tsx",
      linesCreated: 1,
    });
    expect(feedback[2].result.value).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(feedback[3].result.value.files).toEqual(["src/App.tsx"]);
  });

  it("feeds find client tool results back as completed SDK glob calls", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "find source files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_find",
                type: "function",
                function: {
                  name: "find",
                  arguments: JSON.stringify({ pattern: "**/*.tsx", path: "src" }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_find",
            content: '{"files":["src/App.tsx"]}',
          },
        ],
        tools: [
          {
            name: "find",
            input_schema: {
              type: "object",
              properties: {
                pattern: { type: "string" },
                path: { type: "string" },
              },
              required: ["pattern"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("glob");
    expect(feedback.args).toEqual({ targetDirectory: "src", globPattern: "**/*.tsx" });
    expect(feedback.result.value.files).toEqual(["src/App.tsx"]);
    expect(feedback.result.value.totalFiles).toBe(1);
  });

  it("feeds pi bash results back with SDK millisecond timeout arguments", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "run tests" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "npm test", timeout: 120 }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_bash",
            content: '{"exitCode":0,"stdout":"ok","stderr":""}',
          },
        ],
        tools: [
          {
            name: "bash",
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string" },
                timeout: {
                  type: "number",
                  description: "Timeout in seconds (optional, no default timeout)",
                },
              },
              required: ["command"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("shell");
    expect(feedback.args).toEqual({ command: "npm test", timeout: 120_000 });
    expect(feedback.result.value).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  it("feeds pi edit results back with SDK edit argument names", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "edit the app" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_edit",
                type: "function",
                function: {
                  name: "edit",
                  arguments: JSON.stringify({
                    path: "src/App.tsx",
                    oldText: "return null",
                    newText: "return <main />",
                  }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_edit", content: '{"diff":"ok"}' },
        ],
        tools: [
          {
            name: "edit",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["path", "oldText", "newText"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("edit");
    expect(feedback.args).toEqual({
      path: "src/App.tsx",
      oldString: "return null",
      newString: "return <main />",
    });
    expect(feedback.result.value.diffString).toBe("ok");
  });

  it("feeds pi grep results back with SDK grep option names", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "search source files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_grep",
                type: "function",
                function: {
                  name: "grep",
                  arguments: JSON.stringify({
                    pattern: "TODO",
                    path: "src",
                    glob: "*.tsx",
                    ignoreCase: true,
                    literal: true,
                    context: 2,
                    limit: 10,
                  }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_grep", content: "src/App.tsx:1:TODO" },
        ],
        tools: [
          {
            name: "grep",
            input_schema: {
              type: "object",
              properties: {
                pattern: { type: "string" },
                path: { type: "string" },
                glob: { type: "string" },
                ignoreCase: { type: "boolean" },
                literal: { type: "boolean" },
                context: { type: "number" },
                limit: { type: "number" },
              },
              required: ["pattern"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("grep");
    expect(feedback.args).toEqual({
      pattern: "TODO",
      path: "src",
      glob: "*.tsx",
      caseInsensitive: true,
      literal: true,
      context: 2,
      headLimit: 10,
    });
    expect(feedback.result.value.text).toBe("src/App.tsx:1:TODO");
  });

  it("feeds pi ls results back with SDK list argument names", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_ls",
                type: "function",
                function: {
                  name: "ls",
                  arguments: JSON.stringify({ path: "src", limit: 20 }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_ls", content: "App.tsx" },
        ],
        tools: [
          {
            name: "ls",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
                limit: { type: "number" },
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL OPENCODE TOOL RESULT: ".length));
    expect(feedback.name).toBe("ls");
    expect(feedback.args).toEqual({ path: "src", limit: 20 });
    expect(feedback.result.value.text).toBe("App.tsx");
  });

  it("maps SDK builtins to schema-compatible prefixed server tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "probe_write_file",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              file_path: { type: "string" },
              contents: { type: "string" },
            },
            required: ["file_path", "contents"],
          },
        },
      ],
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("probe_write_file");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      file_path: "src/App.tsx",
      contents: "export default function App() { return null }",
    });
  });

  it("does not map SDK edits to schemas missing replacement arguments", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "replace_file",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              search: { type: "string" },
            },
            required: ["path", "search"],
          },
        },
      ],
      toolCalls: [
        {
          name: "edit",
          arguments: { path: "src/App.tsx", oldString: "Hello", newString: "Hi" },
        },
      ],
    });

    expect(toolCalls).toEqual([]);
  });

  it("does not map exact SDK edit names to incompatible schemas", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "edit",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              search: { type: "string" },
            },
            required: ["path", "search"],
          },
        },
      ],
      toolCalls: [
        {
          name: "edit",
          arguments: { path: "src/App.tsx", oldString: "Hello", newString: "Hi" },
        },
      ],
    });

    expect(toolCalls).toEqual([]);
  });

  it("maps SDK ls calls to glob tools when a client has no ls tool", () => {
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
      toolCalls: [{ name: "ls", arguments: { path: "src" } }],
    });

    expect(toolCalls[0].function.name).toBe("glob");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "*",
      path: "src",
    });
  });

  it("emulates SDK file writes through shell when shell is the only compatible client tool", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "bash",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              description: { type: "string" },
            },
            required: ["command", "description"],
          },
        },
      ],
      toolCalls: [
        { name: "write", arguments: { path: "src/App.tsx", fileText: "hello\nworld" } },
      ],
    });

    expect(toolCalls[0].function.name).toBe("bash");
    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.command).toContain("cat > 'src/App.tsx'");
    expect(args.command).toContain("hello\nworld");
    expect(args.description).toContain("mkdir -p");
  });

  it("emulates SDK partial reads through shell without reading the whole file", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "bash",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              description: { type: "string" },
            },
            required: ["command", "description"],
          },
        },
      ],
      toolCalls: [
        { name: "read", arguments: { path: "src/App.tsx", offset: 5, limit: 10 } },
      ],
    });

    expect(toolCalls[0].function.name).toBe("bash");
    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.command).toBe("sed -n '5,14p' 'src/App.tsx'");
    expect(args.description).toBe("Runs sed -n '5,14p' 'src/App.tsx'");
  });

  it("emulates SDK edits through shell when shell is the only compatible client tool", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "run_command",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              description: { type: "string" },
            },
            required: ["command", "description"],
          },
        },
      ],
      toolCalls: [
        {
          name: "edit",
          arguments: {
            path: "src/App.tsx",
            oldString: "return null",
            newString: "return <main />",
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("run_command");
    const args = JSON.parse(toolCalls[0].function.arguments);
    expect(args.command).toContain("from pathlib import Path");
    expect(args.command).toContain('path = Path("src/App.tsx")');
    expect(args.command).toContain('old = "return null"');
    expect(args.command).toContain('new = "return <main />"');
    expect(args.command).toContain("text.replace(old, new, 1)");
    expect(args.description).toContain("python3");
  });

  it("feeds emulated shell tool results back with the original SDK arguments", () => {
    const tools = [
      {
        name: "bash",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            description: { type: "string" },
          },
          required: ["command", "description"],
        },
      },
    ];
    const generated = toOpenAiToolCalls({
      responseId: "chatcmpl_shell_memory",
      tools,
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
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
        { name: "read", arguments: { path: "src/App.tsx", offset: 5, limit: 10 } },
      ],
    });
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "build a todo app" },
          { role: "assistant", content: null, tool_calls: generated },
          {
            role: "tool",
            tool_call_id: generated[0].id,
            content: '{"exitCode":0,"stdout":"","stderr":""}',
          },
          {
            role: "tool",
            tool_call_id: generated[1].id,
            content: '{"exitCode":0,"stdout":"","stderr":""}',
          },
          { role: "tool", tool_call_id: generated[2].id, content: "line 5" },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );

    const feedback = prepared.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL OPENCODE TOOL RESULT: ".length)));

    expect(generated.map((call) => call.function.name)).toEqual([
      "bash",
      "bash",
      "bash",
    ]);
    expect(feedback.map((item) => item.name)).toEqual(["write", "edit", "read"]);
    expect(feedback.map((item) => item.args)).toEqual([
      {
        path: "src/App.tsx",
        fileText: "export default function App() { return null }",
      },
      { path: "src/App.tsx", oldString: "return null", newString: "return <main />" },
      { path: "src/App.tsx", offset: 5, limit: 10 },
    ]);
  });

  it("maps Cursor SDK MCP calls to generic wrapper functions", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "call_mcp_tool",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              serverName: { type: "string" },
              toolName: { type: "string" },
              arguments: { type: "object" },
            },
            required: ["serverName", "toolName", "arguments"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "filesystem",
            toolName: "write_file",
            args: { file_path: "src/App.tsx", contents: "ok" },
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("call_mcp_tool");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      serverName: "filesystem",
      toolName: "write_file",
      arguments: { file_path: "src/App.tsx", contents: "ok" },
    });
  });

  it("drops synthetic SDK shell workdirs so OpenCode uses its local cwd", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "bash",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { command: { type: "string" }, workdir: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      toolCalls: [
        {
          name: "shell",
          arguments: {
            command: "npm install && npm test",
            workingDirectory: "/workspace",
          },
        },
      ],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      command: "npm install && npm test",
    });
  });

  it("fills required shell cwd and timeout fields for strict harness command tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "run_command",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
              timeout_ms: { type: "number" },
              description: { type: "string" },
            },
            required: ["command", "cwd", "timeout_ms", "description"],
          },
        },
      ],
      toolCalls: [
        {
          name: "shell",
          arguments: { command: "npm test", workingDirectory: "/workspace" },
        },
      ],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      command: "npm test",
      cwd: ".",
      timeout_ms: 120_000,
      description: "Runs npm test",
    });
  });

  it("backgrounds SDK server shell calls so OpenCode is not blocked", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "bash",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              workdir: { type: "string" },
              description: { type: "string" },
            },
            required: ["command", "description"],
          },
        },
      ],
      toolCalls: [
        {
          name: "shell",
          arguments: {
            command: "python3 -m http.server 8080",
            workingDirectory: "/Users/example/site",
          },
        },
      ],
    });

    const args = JSON.parse(toolCalls[0].function.arguments) as Record<string, string>;
    expect(args.command).toContain("nohup sh -lc 'python3 -m http.server 8080'");
    expect(args.command).toMatch(/\/tmp\/opencode-background-[0-9a-f]{8}\.log/);
    expect(args.command).toContain('& echo "Started background process pid=$!');
    expect(args.workdir).toBe("/Users/example/site");
    expect(args.description).toBe(
      "Starts background process: Runs python3 -m http.server 8080",
    );
  });

  it("preserves recursive Cursor targeting without leaking absolute target paths into glob patterns", () => {
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
      toolCalls: [
        {
          name: "file_search",
          arguments: { targeting: "/Users/example/project/**", glob_pattern: "*.ts" },
        },
      ],
    });

    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ pattern: "**/*.ts" });
  });
});
