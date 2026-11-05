import { describe, expect, it } from "vitest";
import {
  prepareChatRequest,
  prepareOpencodeSdkChatRequest,
  prepareResponsesRequest,
  toOpenAiToolCalls,
} from "../../src/openai.js";

describe("OpenAI compatibility adapter - chat-and-responses-core", () => {
  it("converts chat messages and image URLs into Cursor prompts", () => {
    const prepared = prepareChatRequest(
      {
        model: "composer-2.5",
        messages: [
          { role: "system", content: "Be terse." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image_url",
                image_url: {
                  url: "https://example.com/image.png",
                  width: 640,
                  height: 480,
                },
              },
            ],
          },
        ],
        max_tokens: 50,
      },
      { id: "composer-2.5" },
    );
    expect(prepared.prompt.text).toContain("SYSTEM: Be terse.");
    expect(prepared.prompt.text).toContain(
      "You are serving an OpenAI-compatible API request.",
    );
    expect(prepared.prompt.text).not.toContain("through Cursor Composer");
    expect(prepared.prompt.text).toContain("USER: What is this?");
    expect(prepared.prompt.text).toContain("within about 50 output tokens");
    expect(prepared.prompt.images).toEqual([
      { url: "https://example.com/image.png", dimension: { width: 640, height: 480 } },
    ]);
  });

  it("converts Responses input images into Cursor prompts", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is in this image?" },
              {
                type: "input_image",
                image_url: {
                  url: "data:image/jpeg;base64,AQID",
                  width: 320,
                  height: 240,
                },
              },
            ],
          },
        ],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.prompt.text).toContain(
      "You are serving an OpenAI-compatible API request.",
    );
    expect(prepared.prompt.text).not.toContain("through Cursor Composer");
    expect(prepared.prompt.text).toContain("USER: What is in this image?");
    expect(prepared.prompt.images).toEqual([
      { mimeType: "image/jpeg", data: "AQID", dimension: { width: 320, height: 240 } },
    ]);
  });

  it("accepts OpenAI function tools and includes them in the Cursor prompt", () => {
    const prepared = prepareChatRequest(
      {
        model: "composer-2.5",
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "glob",
              description: "Find files",
              parameters: {
                type: "object",
                properties: { pattern: { type: "string" } },
              },
            },
          },
        ],
      },
      { id: "composer-2.5" },
    );
    expect(prepared.tools).toEqual([
      {
        name: "glob",
        description: "Find files",
        parameters: { type: "object", properties: { pattern: { type: "string" } } },
      },
    ]);
    expect(prepared.prompt.mode).toBe("agent");
    expect(prepared.prompt.text).toContain("already in Agent mode");
    expect(prepared.prompt.text).toContain("Never claim that tools are unavailable");
    expect(prepared.prompt.text).not.toContain("through Cursor Composer");
    expect(prepared.prompt.text).toContain("CLIENT TOOL INVENTORY:");
    expect(prepared.prompt.text).toContain("Allowed tool names: glob");
    expect(prepared.prompt.text).toContain("Switched to agent mode successfully");
    expect(prepared.prompt.text).toContain('"name":"glob"');
  });

  it("accepts bare harness tools with input_schema and maps SDK glob arguments to that schema", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "find source files" }],
        tools: [
          {
            name: "glob",
            description: "Find files",
            input_schema: {
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
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.tools).toEqual([
      {
        name: "glob",
        description: "Find files",
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
    ]);

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: prepared.tools,
      toolCalls: [
        {
          name: "glob",
          arguments: { targetDirectory: "src", globPattern: "**/*.tsx" },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("glob");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*.tsx",
      path: "src",
    });
  });

  it("advertises pi find through the native SDK glob route", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "find source files" }],
        tool_choice: { type: "function", function: { name: "find" } },
        tools: [
          {
            name: "find",
            description: "Find files by glob pattern",
            input_schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                pattern: { type: "string" },
                path: { type: "string" },
                limit: { type: "number" },
              },
              required: ["pattern"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain('"name":"find"');
    expect(prepared.prompt.text).not.toContain(
      '"sdk_mcp":{"providerIdentifier":"client","toolName":"find"',
    );
    expect(prepared.prompt.text).toContain('"sdk":"glob","client":"find"');
    expect(prepared.prompt.text).toContain(
      "Use SDK glob now; it will be forwarded to client tool find",
    );

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: prepared.tools,
      toolCalls: [
        {
          name: "glob",
          arguments: { targetDirectory: "src", globPattern: "**/*.tsx" },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("find");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*.tsx",
      path: "src",
    });
  });

  it("maps exact SDK MCP calls to built-in client tool schemas", () => {
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
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "glob",
            args: { pattern: "**/*.tsx", path: "src" },
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("glob");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "**/*.tsx",
      path: "src",
    });
  });

  it("maps SDK grep arguments to pi grep schemas", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "grep",
          parameters: {
            type: "object",
            additionalProperties: false,
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
      toolCalls: [
        {
          name: "grep",
          arguments: {
            pattern: "TODO",
            path: "src",
            glob: "*.tsx",
            caseInsensitive: true,
            literal: true,
            context: 2,
            headLimit: 10,
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("grep");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      pattern: "TODO",
      path: "src",
      glob: "*.tsx",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 10,
    });
  });

  it("maps SDK edit arguments to pi edit schemas", () => {
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
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["path", "oldText", "newText"],
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

    expect(toolCalls[0].function.name).toBe("edit");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      path: "src/App.tsx",
      oldText: "return null",
      newText: "return <main />",
    });
  });

  it("maps the full pi built-in tool schema matrix", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "bash",
          parameters: {
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
        {
          name: "read",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              offset: { type: "number" },
              limit: { type: "number" },
            },
            required: ["path"],
          },
        },
        {
          name: "write",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        {
          name: "edit",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["path", "oldText", "newText"],
          },
        },
        {
          name: "find",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              path: { type: "string" },
              limit: { type: "number" },
            },
            required: ["pattern"],
          },
        },
        {
          name: "grep",
          parameters: {
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
        {
          name: "ls",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, limit: { type: "number" } },
          },
        },
      ],
      toolCalls: [
        { name: "shell", arguments: { command: "npm test", timeout: 120_000 } },
        { name: "read", arguments: { path: "src/App.tsx", offset: 5, limit: 20 } },
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
        {
          name: "glob",
          arguments: { globPattern: "**/*.tsx", targetDirectory: "src" },
        },
        {
          name: "grep",
          arguments: {
            pattern: "TODO",
            path: "src",
            glob: "*.tsx",
            caseInsensitive: true,
            literal: true,
            context: 2,
            headLimit: 10,
          },
        },
        { name: "ls", arguments: { path: "src", limit: 50 } },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "find",
      "grep",
      "ls",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { command: "npm test", timeout: 120 },
      { path: "src/App.tsx", offset: 5, limit: 20 },
      { path: "src/App.tsx", content: "export default function App() { return null }" },
      { path: "src/App.tsx", oldText: "return null", newText: "return <main />" },
      { pattern: "**/*.tsx", path: "src" },
      {
        pattern: "TODO",
        path: "src",
        glob: "*.tsx",
        ignoreCase: true,
        literal: true,
        context: 2,
        limit: 10,
      },
      { path: "src", limit: 50 },
    ]);
  });

  it("uses OpenCode working directory to normalize SDK file and glob calls to real OpenCode schemas", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "system",
            content: [
              "Environment:",
              "  Working directory: /tmp/project",
              "  Workspace root folder: /tmp/project",
            ].join("\n"),
          },
          { role: "user", content: "build a todo app in vite 8 and react" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "write",
              description: "Writes a file to the local filesystem.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  content: {
                    type: "string",
                    description: "The content to write to the file",
                  },
                  filePath: {
                    type: "string",
                    description:
                      "The absolute path to the file to write (must be absolute, not relative)",
                  },
                },
                required: ["content", "filePath"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "read",
              description: "Read a file or directory from the local filesystem.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  filePath: {
                    type: "string",
                    description: "The absolute path to the file or directory to read",
                  },
                },
                required: ["filePath"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "edit",
              description: "Performs exact string replacements in files.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  filePath: {
                    type: "string",
                    description: "The absolute path to the file to modify",
                  },
                  oldString: { type: "string" },
                  newString: { type: "string" },
                },
                required: ["filePath", "oldString", "newString"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "glob",
              description: "Fast file pattern matching tool.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  pattern: {
                    type: "string",
                    description: "The glob pattern to match files against",
                  },
                  path: { type: "string", description: "The directory to search in" },
                },
                required: ["pattern"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.toolContext).toEqual({ workingDirectory: "/tmp/project" });

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: prepared.tools,
      context: prepared.toolContext,
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.tsx",
            fileText: "export default function App() { return null }",
          },
        },
        { name: "read", arguments: { path: "src/App.tsx" } },
        {
          name: "edit",
          arguments: {
            path: "src/App.tsx",
            oldString: "return null",
            newString: "return <main />",
          },
        },
        { name: "glob", arguments: { targeting: "src/**", glob_pattern: "*.tsx" } },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "write",
      "read",
      "edit",
      "glob",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        content: "export default function App() { return null }",
        filePath: "/tmp/project/src/App.tsx",
      },
      { filePath: "/tmp/project/src/App.tsx" },
      {
        filePath: "/tmp/project/src/App.tsx",
        oldString: "return null",
        newString: "return <main />",
      },
      { pattern: "**/*.tsx", path: "/tmp/project/src" },
    ]);
  });

  it("expands home-relative SDK paths for absolute OpenCode file schemas", () => {
    const tools = [
      {
        name: "write",
        parameters: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "The absolute path to the file to write",
            },
            content: { type: "string" },
          },
          required: ["filePath", "content"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_home_path",
      tools,
      context: { workingDirectory: "/Users/example/project" },
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "~/Desktop/rain-in-spain.html",
            fileText: "<main>Rain</main>",
          },
        },
      ],
    });

    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        filePath: "/Users/example/Desktop/rain-in-spain.html",
        content: "<main>Rain</main>",
      },
    ]);
  });

  it("maps the live OpenCode build tool matrix including unique client tools", () => {
    const openCodeBuildTools = [
      {
        name: "bash",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout: { type: "integer" },
            workdir: { type: "string" },
            description: { type: "string" },
          },
          required: ["command", "description"],
        },
      },
      {
        name: "edit",
        parameters: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "The absolute path to the file to modify",
            },
            oldString: { type: "string" },
            newString: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["filePath", "oldString", "newString"],
        },
      },
      {
        name: "glob",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string", description: "The directory to search in" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "grep",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            include: { type: "string" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "read",
        parameters: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "The absolute path to the file or directory to read",
            },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "skill",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      {
        name: "task",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string" },
            prompt: { type: "string" },
            subagent_type: { type: "string" },
            task_id: { type: "string" },
            command: { type: "string" },
          },
          required: ["description", "prompt", "subagent_type"],
        },
      },
      {
        name: "todowrite",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string" },
                  priority: { type: "string" },
                },
                required: ["content", "status", "priority"],
              },
            },
          },
          required: ["todos"],
        },
      },
      {
        name: "webfetch",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            format: {
              anyOf: [
                { type: "string", enum: ["text", "markdown", "html"] },
                { type: "null" },
              ],
            },
            timeout: { type: "number" },
          },
          required: ["url"],
        },
      },
      {
        name: "write",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
            filePath: {
              type: "string",
              description:
                "The absolute path to the file to write (must be absolute, not relative)",
            },
          },
          required: ["content", "filePath"],
        },
      },
    ];

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: openCodeBuildTools,
      context: { workingDirectory: "/tmp/project" },
      toolCalls: [
        {
          name: "shell",
          arguments: {
            command: "npm test",
            timeout: 120_000,
            workingDirectory: "/tmp/project",
          },
        },
        { name: "read", arguments: { path: "src/App.tsx", offset: 5, limit: 20 } },
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
            replaceAll: true,
          },
        },
        {
          name: "glob",
          arguments: { targetDirectory: "src", globPattern: "**/*.tsx" },
        },
        { name: "grep", arguments: { pattern: "TODO", path: "src", glob: "*.tsx" } },
        {
          name: "todowrite",
          arguments: {
            todos: [{ content: "Build app", status: "in_progress", priority: "high" }],
          },
        },
        { name: "delete", arguments: { path: "src/old.tsx" } },
        { name: "ls", arguments: { path: "src" } },
        {
          name: "semsearch",
          arguments: { query: "submit button", targetDirectories: ["src"] },
        },
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "webfetch",
            args: { url: "https://example.com", format: "markdown", timeout: 10 },
          },
        },
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "task",
            args: {
              description: "Inspect app",
              prompt: "Find the app entry point",
              subagent_type: "explore",
              command: "inspect",
            },
          },
        },
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "skill",
            args: { name: "customize-opencode" },
          },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "todowrite",
      "bash",
      "glob",
      "bash",
      "webfetch",
      "task",
      "skill",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        command: "npm test",
        timeout: 120_000,
        workdir: "/tmp/project",
        description: "Runs npm test",
      },
      { filePath: "/tmp/project/src/App.tsx", offset: 5, limit: 20 },
      {
        filePath: "/tmp/project/src/App.tsx",
        content: "export default function App() { return null }",
      },
      {
        filePath: "/tmp/project/src/App.tsx",
        oldString: "return null",
        newString: "return <main />",
        replaceAll: true,
      },
      { pattern: "**/*.tsx", path: "/tmp/project/src" },
      { pattern: "TODO", path: "src", include: "*.tsx" },
      { todos: [{ content: "Build app", status: "in_progress", priority: "high" }] },
      { command: "rm -rf 'src/old.tsx'", description: "Runs rm -rf 'src/old.tsx'" },
      { pattern: "*", path: "src" },
      {
        command: "rg --line-number --color never --hidden 'submit button' 'src'",
        description: "Runs rg --line-number --color never --hidden",
      },
      { url: "https://example.com", format: "markdown", timeout: 10 },
      {
        description: "Inspect app",
        prompt: "Find the app entry point",
        subagent_type: "explore",
        command: "inspect",
      },
      { name: "customize-opencode" },
    ]);
  });

  it("maps a Vite React app-build flow through strict OpenCode schemas", () => {
    const tools = [
      {
        name: "bash",
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
      {
        name: "write",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            filePath: {
              type: "string",
              description: "The absolute path to the file to write",
            },
            content: { type: "string" },
          },
          required: ["filePath", "content"],
        },
      },
      {
        name: "edit",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            filePath: {
              type: "string",
              description: "The absolute path to the file to modify",
            },
            oldString: { type: "string" },
            newString: { type: "string" },
          },
          required: ["filePath", "oldString", "newString"],
        },
      },
    ];
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "system", content: "Working directory: /tmp/todo-vite" },
          { role: "user", content: "build a todo app in vite 8 and react" },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.requiresLocalTool).toBe(true);
    expect(prepared.prompt.text).toContain(
      "Client tool targets: bash, glob, write, edit",
    );
    expect(prepared.prompt.text).not.toContain("Allowed tool names: bash");
    expect(prepared.prompt.text).toContain("SDK TOOL ROUTING MAP:");
    expect(prepared.prompt.text).toContain(
      '"sdk":"glob","client":"glob","clientArgs":{"pattern":"**/*","path":"/tmp/todo-vite"}',
    );
    expect(prepared.prompt.text).toContain(
      '"sdk":"shell","client":"bash","clientArgs":{"command":"<command>","cwd":".","timeout_ms":120000',
    );
    const generated = toOpenAiToolCalls({
      responseId: "chatcmpl_vite_flow",
      tools: prepared.tools,
      context: prepared.toolContext,
      toolCalls: [
        { name: "glob", arguments: { targetDirectory: "." } },
        {
          name: "shell",
          arguments: {
            command: "npm create vite@latest . -- --template react",
            workingDirectory: "/workspace",
          },
        },
        {
          name: "write",
          arguments: {
            path: "src/App.jsx",
            fileText: "export default function App() { return <main>Todos</main> }",
          },
        },
        {
          name: "edit",
          arguments: {
            path: "package.json",
            oldString: '"scripts": {',
            newString: '"scripts": {',
          },
        },
        {
          name: "shell",
          arguments: { command: "npm install && npm run build", timeout: 120_000 },
        },
      ],
    });

    expect(generated.map((call) => call.function.name)).toEqual([
      "glob",
      "bash",
      "write",
      "edit",
      "bash",
    ]);
    expect(generated.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { pattern: "**/*", path: "/tmp/todo-vite" },
      {
        command: "npm create vite@latest . -- --template react",
        cwd: ".",
        timeout_ms: 120_000,
        description: "Runs npm create vite@latest . --",
      },
      {
        filePath: "/tmp/todo-vite/src/App.jsx",
        content: "export default function App() { return <main>Todos</main> }",
      },
      {
        filePath: "/tmp/todo-vite/package.json",
        oldString: '"scripts": {',
        newString: '"scripts": {',
      },
      {
        command: "npm install && npm run build",
        cwd: ".",
        timeout_ms: 120_000,
        description: "Runs npm install && npm run",
      },
    ]);

    const continued = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "system", content: "Working directory: /tmp/todo-vite" },
          { role: "user", content: "build a todo app in vite 8 and react" },
          { role: "assistant", content: null, tool_calls: generated },
          { role: "tool", tool_call_id: generated[0].id, content: '{"files":[]}' },
          {
            role: "tool",
            tool_call_id: generated[1].id,
            content: '{"exitCode":0,"stdout":"created","stderr":""}',
          },
          { role: "tool", tool_call_id: generated[2].id, content: '{"content":"ok"}' },
          { role: "tool", tool_call_id: generated[3].id, content: '{"diff":"ok"}' },
          {
            role: "tool",
            tool_call_id: generated[4].id,
            content: '{"exitCode":0,"stdout":"built","stderr":""}',
          },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );
    const feedback = continued.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL OPENCODE TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL OPENCODE TOOL RESULT: ".length)));

    expect(feedback.map((item) => item.name)).toEqual([
      "glob",
      "shell",
      "write",
      "edit",
      "shell",
    ]);
    expect(feedback.map((item) => item.args)).toEqual([
      { targetDirectory: "." },
      {
        command: "npm create vite@latest . -- --template react",
        workingDirectory: "/workspace",
      },
      {
        path: "src/App.jsx",
        fileText: "export default function App() { return <main>Todos</main> }",
      },
      { path: "package.json", oldString: '"scripts": {', newString: '"scripts": {' },
      { command: "npm install && npm run build", timeout: 120_000 },
    ]);
  });

  it("keeps direct chat tools on direct tool-call syntax", () => {
    const prepared = prepareChatRequest(
      {
        model: "composer-2.5",
        messages: [
          {
            role: "user",
            content: "Use the webfetch tool to fetch https://example.com",
          },
        ],
        tool_choice: { type: "function", function: { name: "webfetch" } },
        tools: [
          {
            type: "function",
            function: {
              name: "webfetch",
              description: "Fetch a URL",
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
      { id: "composer-2.5" },
    );

    expect(prepared.prompt.text).toContain("CLIENT TOOL INVENTORY:");
    expect(prepared.prompt.text).toContain("Use the webfetch tool if you call a tool.");
    expect(prepared.prompt.text).not.toContain("sdk_mcp");
    expect(prepared.prompt.text).not.toContain("Use SDK mcp now");
  });

  it("advertises single-word non-builtin client tools through synthetic SDK MCP targets", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "user",
            content: "Use the webfetch tool to fetch https://example.com",
          },
        ],
        tool_choice: { type: "function", function: { name: "webfetch" } },
        tools: [
          {
            name: "webfetch",
            description: "Fetch a URL",
            input_schema: {
              type: "object",
              properties: {
                url: { type: "string" },
                format: { type: "string" },
              },
              required: ["url"],
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain(
      '"sdk_mcp":{"providerIdentifier":"client","toolName":"webfetch","args":"match this tool schema"}',
    );
    expect(prepared.prompt.text).toContain(
      '"sdk":"mcp","client":"webfetch","sdkArgs":{"providerIdentifier":"client","toolName":"webfetch","args":"match client schema"}',
    );
    expect(prepared.prompt.text).toContain(
      'Use SDK mcp now with providerIdentifier "client", toolName "webfetch"',
    );
  });

  it("accepts server tool schemas and skips nameless built-in response tools", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: "search the repo",
        tools: [
          { type: "web_search_preview" },
          {
            type: "server_tool",
            name: "repo_search",
            description: "Search repository symbols",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          },
        ],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.tools).toEqual([
      {
        name: "repo_search",
        description: "Search repository symbols",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ]);
    expect(prepared.prompt.text).toContain("Client tool targets: repo_search");
    expect(prepared.prompt.text).toContain(
      "These are client execution targets, not the names you should emit.",
    );
    expect(prepared.responseMetadata.tools).toEqual([
      {
        type: "function",
        name: "repo_search",
        description: "Search repository symbols",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ]);
  });

  it("requires workspace tools for create/build style requests", () => {
    const prepared = prepareChatRequest(
      {
        model: "composer-2.5",
        messages: [{ role: "user", content: "make me a simple landing page" }],
        tools: [
          {
            type: "function",
            function: {
              name: "write",
              description: "Write a file",
              parameters: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
          },
        ],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.prompt.text).toContain("WORKSPACE MUTATION REQUIRED:");
    expect(prepared.prompt.text).toContain(
      "Do not output a standalone file for the user to save",
    );
    expect(prepared.prompt.text).toContain(
      "Your next assistant response must be a write/edit/bash tool call",
    );
    expect(prepared.prompt.text).toContain("Workspace action required");
  });

  it("does not force another mutation tool after one has been called", () => {
    const prepared = prepareChatRequest(
      {
        model: "composer-2.5",
        messages: [
          { role: "user", content: "make me a simple landing page" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "write", arguments: '{"filePath":"index.html"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            name: "write",
            content: "Wrote file successfully.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "write",
              description: "Write a file",
              parameters: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  content: { type: "string" },
                },
              },
            },
          },
        ],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.prompt.text).toContain(
      "A file-mutating tool call has already been made",
    );
    expect(prepared.prompt.text).not.toContain(
      "Your next assistant response must be a write/edit/bash tool call",
    );
  });

  it("keeps SDK workspace mutation required after non-mutating shell probes", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "build a complete TypeScript CLI project" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_ls",
                type: "function",
                function: { name: "bash", arguments: '{"command":"pwd && ls -la"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_ls",
            name: "bash",
            content: '{"exitCode":0,"stdout":"empty","stderr":""}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain("SDK WORKSPACE MUTATION REQUIRED:");
    expect(prepared.prompt.text).toContain(
      "When starting a dev server or other long-running watcher",
    );
    expect(prepared.prompt.text).toContain(
      "No file-mutating tool call has been made yet",
    );
    expect(prepared.prompt.text).not.toContain(
      "A file-mutating tool call has already been made",
    );
  });

  it("requires SDK local tools for explicit desktop file writes", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "user",
            content:
              "Please save rain-in-spain.html on ~/Desktop with a short paragraph.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.requiresLocalTool).toBe(true);
    expect(prepared.prompt.text).toContain("SDK WORKSPACE MUTATION REQUIRED:");
    expect(prepared.prompt.text).toContain(
      "Your next tool call must be write or shell",
    );
  });

  it("requires SDK local tools for server start requests", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "start the local dev server" }],
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a shell command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.requiresLocalTool).toBe(true);
    expect(prepared.prompt.text).toContain(
      "When starting a dev server or other long-running watcher",
    );
  });

  it("requires SDK local tools for explicitly requested non-mutating tools", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "glob",
          description: "Find files",
          parameters: {
            type: "object",
            properties: { pattern: { type: "string" }, path: { type: "string" } },
            required: ["pattern"],
          },
        },
      },
    ];
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "user",
            content: "Use the glob tool, not bash, to find **/*.tsx files.",
          },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.requiresLocalTool).toBe(true);
    expect(prepared.prompt.text).toContain(
      "Use SDK glob now; it will be forwarded to client tool glob",
    );

    const generated = toOpenAiToolCalls({
      responseId: "chatcmpl_explicit_glob",
      tools: prepared.tools,
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "glob",
            args: { pattern: "**/*.tsx" },
          },
        },
      ],
    });
    const continued = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "user",
            content: "Use the glob tool, not bash, to find **/*.tsx files.",
          },
          { role: "assistant", content: null, tool_calls: generated },
          {
            role: "tool",
            tool_call_id: generated[0].id,
            name: "glob",
            content: '{"files":["src/App.tsx"]}',
          },
        ],
        tools,
      },
      { id: "composer-2.5-sdk" },
    );

    expect(continued.requiresLocalTool).toBe(false);
    expect(continued.prompt.text).not.toContain(
      "No file-mutating tool call has been made yet",
    );
  });
});
