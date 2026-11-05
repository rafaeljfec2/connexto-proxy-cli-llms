import { describe, expect, it } from "vitest";
import {
  prepareOpencodeSdkChatRequest,
  prepareResponsesRequest,
  chatCompletionResponse,
  chatUsageChunk,
  responseObject,
  toOpenAiToolCalls,
} from "../../src/openai.js";

describe("OpenAI compatibility adapter - responses-and-objects", () => {
  it("requires SDK workspace mutation for schema-compatible custom writers", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "build a todo app in vite 8 and react" }],
        tools: [
          {
            type: "function",
            function: {
              name: "project_files",
              parameters: {
                type: "object",
                properties: {
                  input: {
                    type: "object",
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
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain("SDK WORKSPACE MUTATION REQUIRED:");
    expect(prepared.prompt.text).toContain(
      "Your next tool call must be write or shell",
    );
    expect(prepared.requiresLocalTool).toBe(true);
  });

  it("marks SDK workspace mutation done after a schema-compatible custom writer call", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          { role: "user", content: "build a todo app in vite 8 and react" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_project_file",
                type: "function",
                function: {
                  name: "project_files",
                  arguments: JSON.stringify({
                    input: {
                      action: "write",
                      path: "src/App.tsx",
                      content: "export default function App() { return null; }",
                    },
                  }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_project_file",
            name: "project_files",
            content: "Wrote src/App.tsx",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "project_files",
              parameters: {
                type: "object",
                properties: {
                  input: {
                    type: "object",
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
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain(
      "A file-mutating tool call has already been made",
    );
    expect(prepared.prompt.text).not.toContain(
      "No file-mutating tool call has been made yet",
    );
    expect(prepared.requiresLocalTool).toBe(false);
  });

  it("does not force SDK workspace mutation when no writable or shell tool is compatible", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "build a todo app in vite 8 and react" }],
        tools: [
          {
            type: "function",
            function: {
              name: "notify",
              parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).not.toContain("SDK WORKSPACE MUTATION REQUIRED:");
    expect(prepared.prompt.text).not.toContain(
      "Your next tool call must be write or shell",
    );
    expect(prepared.requiresLocalTool).toBe(false);
  });

  it("prefers explicitly requested OpenCode MCP tools in SDK prompts", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [
          {
            role: "user",
            content:
              "Use the probe_write_file tool, not bash, to create mcp-marker.txt containing MCP_OK.",
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
          {
            type: "function",
            function: {
              name: "probe_write_file",
              description: "Write through probe MCP",
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

    expect(prepared.prompt.text).toContain(
      'Use SDK mcp now with providerIdentifier "probe", toolName "write_file"',
    );
    expect(prepared.prompt.text).toContain(
      "Do not use SDK shell/write as a substitute",
    );
    expect(prepared.prompt.text).toContain(
      "When the user names a specific allowed client tool, use the matching SDK TOOL ROUTING MAP route",
    );
    expect(prepared.prompt.text).not.toContain(
      '"sdk":"read","client":"probe_write_file"',
    );
    expect(prepared.prompt.text).not.toContain(
      "Your next tool call must be write or shell",
    );
    expect(prepared.requiresLocalTool).toBe(true);
  });

  it("marks SDK workspace mutation done after a file-writing shell command", () => {
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
                id: "call_write",
                type: "function",
                function: {
                  name: "bash",
                  arguments:
                    '{"command":"cat > package.json <<\'EOF\'\\n{\\"type\\":\\"module\\"}\\nEOF"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_write",
            name: "bash",
            content: '{"exitCode":0,"stdout":"","stderr":""}',
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

    expect(prepared.prompt.text).toContain(
      "A file-mutating tool call has already been made",
    );
    expect(prepared.prompt.text).not.toContain(
      "No file-mutating tool call has been made yet",
    );
    expect(prepared.requiresLocalTool).toBe(false);
  });

  it("marks Responses workspace mutation done after an apply_patch function call", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "build a todo app in vite 8 and react" },
            ],
          },
          {
            type: "function_call",
            call_id: "call_patch",
            name: "apply_patch",
            arguments: JSON.stringify({
              patch:
                "*** Begin Patch\n*** Add File: src/App.tsx\n+export default function App() { return null; }\n*** End Patch",
            }),
          },
          { type: "function_call_output", call_id: "call_patch", output: "Done" },
        ],
        tools: [
          {
            type: "function",
            name: "apply_patch",
            parameters: {
              type: "object",
              properties: {
                patch: { type: "string" },
              },
              required: ["patch"],
            },
          },
        ],
      },
      { id: "composer-2.5" },
    );

    expect(prepared.prompt.text).toContain(
      "A file-mutating tool call has already been made",
    );
    expect(prepared.prompt.text).not.toContain("Use SDK write now");
    expect(prepared.requiresLocalTool).toBe(false);
  });

  it("converts Responses input arrays", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        instructions: "Use JSON.",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        text: { format: { type: "json_object" } },
      },
      { id: "composer-2.5" },
    );
    expect(prepared.prompt.text).toContain("INSTRUCTIONS:");
    expect(prepared.prompt.text).toContain("USER: hello");
    expect(prepared.prompt.text).toContain("valid JSON object");
  });

  it("accepts Responses function tools and carries function outputs into the prompt", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "build a todo app in vite 8 and react" },
            ],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "glob",
            arguments: '{"pattern":"*"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "[]" },
        ],
        tools: [
          {
            type: "function",
            name: "glob",
            description: "Find files",
            parameters: {
              type: "object",
              properties: { pattern: { type: "string" } },
              required: ["pattern"],
            },
          },
        ],
        tool_choice: "required",
      },
      { id: "composer-2.5" },
    );

    expect(prepared.tools).toEqual([
      {
        name: "glob",
        description: "Find files",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
      },
    ]);
    expect(prepared.prompt.mode).toBe("agent");
    expect(prepared.prompt.text).toContain("LOCAL TOOL INVENTORY:");
    expect(prepared.prompt.text).toContain("Client tool targets: glob");
    expect(prepared.prompt.text).toContain(
      "emit only SDK tool names from the SDK TOOL ROUTING MAP",
    );
    expect(prepared.prompt.text).toContain("LOCAL TOOL RESULT:");
    expect(prepared.prompt.text).toContain("You must call at least one tool.");
    expect(prepared.responseMetadata.tools).toEqual([
      {
        type: "function",
        name: "glob",
        description: "Find files",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
      },
    ]);
  });

  it("feeds Responses pi bash outputs back with SDK millisecond timeout arguments", () => {
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          { role: "user", content: "run tests" },
          {
            type: "function_call",
            call_id: "call_bash",
            name: "bash",
            arguments: '{"command":"npm test","timeout":120}',
          },
          {
            type: "function_call_output",
            call_id: "call_bash",
            output: '{"exitCode":0,"stdout":"ok","stderr":""}',
          },
        ],
        tools: [
          {
            type: "function",
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
        ],
      },
      { id: "composer-2.5" },
    );

    const line = prepared.prompt.text
      .split("\n")
      .find((item) => item.startsWith("LOCAL TOOL RESULT: "));
    expect(line).toBeTruthy();
    const feedback = JSON.parse(line!.slice("LOCAL TOOL RESULT: ".length));
    expect(feedback.name).toBe("shell");
    expect(feedback.args).toEqual({ command: "npm test", timeout: 120_000 });
    expect(feedback.result.value).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  it("feeds Responses generic harness outputs back with SDK builtin names from generated call ids", () => {
    const fileText = "export default function App() { return null }";
    const tools = [
      {
        type: "function",
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
        type: "function",
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
        type: "function",
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
      responseId: "resp_generic",
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
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          { role: "user", content: "build and inspect files" },
          ...generated.flatMap((toolCall, index) => [
            {
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
            {
              type: "function_call_output",
              call_id: toolCall.id,
              output: [
                '{"content":"ok"}',
                '{"diff":"updated"}',
                '{"exitCode":0,"stdout":"ok","stderr":""}',
                '{"files":["src/App.tsx"]}',
              ][index],
            },
          ]),
        ],
        tools,
      },
      { id: "composer-2.5" },
    );

    const feedback = prepared.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL TOOL RESULT: ".length)));

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
  });

  it("feeds Responses emulated shell outputs back with original SDK arguments", () => {
    const tools = [
      {
        type: "function",
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
      responseId: "resp_shell_memory",
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
      ],
    });
    const prepared = prepareResponsesRequest(
      {
        model: "composer-2.5",
        input: [
          { role: "user", content: "build a todo app" },
          ...generated.flatMap((toolCall) => [
            {
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
            {
              type: "function_call_output",
              call_id: toolCall.id,
              output: '{"exitCode":0,"stdout":"","stderr":""}',
            },
          ]),
        ],
        tools,
      },
      { id: "composer-2.5" },
    );

    const feedback = prepared.prompt.text
      .split("\n")
      .filter((item) => item.startsWith("LOCAL TOOL RESULT: "))
      .map((line) => JSON.parse(line.slice("LOCAL TOOL RESULT: ".length)));

    expect(generated.map((call) => call.function.name)).toEqual(["bash", "bash"]);
    expect(feedback.map((item) => item.name)).toEqual(["write", "edit"]);
    expect(feedback.map((item) => item.args)).toEqual([
      {
        path: "src/App.tsx",
        fileText: "export default function App() { return null }",
      },
      { path: "src/App.tsx", oldString: "return null", newString: "return <main />" },
    ]);
  });

  it("returns OpenAI-shaped response objects", () => {
    const chat = chatCompletionResponse({
      id: "chatcmpl_test",
      created: 1,
      model: "composer-2.5",
      text: "hello",
      promptChars: 20,
    });
    expect(chat).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: {
        cost: {
          estimated: true,
          pricing: {
            input_per_million_tokens_usd: 0.5,
            output_per_million_tokens_usd: 2.5,
          },
        },
      },
    });

    const response = responseObject({
      id: "resp_test",
      created: 1,
      model: "composer-2.5",
      text: "hello",
      promptChars: 20,
    });
    expect(response).toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      usage: {
        cost: {
          estimated: true,
          pricing: {
            input_per_million_tokens_usd: 0.5,
            output_per_million_tokens_usd: 2.5,
          },
        },
      },
    });
  });

  it("emits an OpenAI-style final usage chunk for streamed chat", () => {
    const chunk = new TextDecoder().decode(
      chatUsageChunk({
        id: "chatcmpl_test",
        created: 1,
        model: "composer-2.5",
        promptChars: 20,
        completionChars: 5,
      }),
    );

    expect(chunk).toContain('"choices":[]');
    expect(chunk).toContain('"usage"');
    expect(chunk).toContain('"total_tokens"');
    expect(chunk).toContain('"total_usd"');
  });

  it("returns OpenAI-shaped tool call responses", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "glob",
          parameters: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
      toolCalls: [{ name: "Glob", arguments: { glob_pattern: "*" } }],
    });
    const chat = chatCompletionResponse({
      id: "chatcmpl_test",
      created: 1,
      model: "composer-2.5",
      text: "",
      toolCalls,
      promptChars: 20,
    });
    expect(chat).toMatchObject({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "glob", arguments: '{"pattern":"*"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  });

  it("normalizes Cursor-style tool names and arguments to the client schema", () => {
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
        {
          name: "edit",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              filePath: { type: "string" },
              oldString: { type: "string" },
              newString: { type: "string" },
            },
            required: ["filePath", "oldString", "newString"],
          },
        },
        {
          name: "bash",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            target_file: "index.html",
            new_contents: "<main>Hello</main>",
            extra: "drop me",
          },
        },
        {
          name: "edit_file",
          arguments: { path: "index.html", old_string: "Hello", new_contents: "Hi" },
        },
        { name: "run_terminal_cmd", arguments: { cmd: "npm test" } },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "write",
      "edit",
      "bash",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { filePath: "index.html", content: "<main>Hello</main>" },
      { filePath: "index.html", oldString: "Hello", newString: "Hi" },
      { command: "npm test" },
    ]);
  });

  it("maps SDK calls through composed and wrapped JSON schemas", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "build the app" }],
        tools: [
          {
            name: "run_command",
            json_schema: {
              schema: {
                allOf: [
                  {
                    type: "object",
                    properties: {
                      shellCommand: { type: "string" },
                    },
                    required: ["shellCommand"],
                  },
                  {
                    type: "object",
                    properties: {
                      workingDir: { type: "string" },
                      timeoutSeconds: {
                        type: "number",
                        description: "Timeout in seconds",
                      },
                      description: { type: "string" },
                    },
                  },
                ],
                additionalProperties: false,
              },
            },
          },
          {
            name: "workspace_file",
            input_schema: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    action: { type: "string", const: "create" },
                    target: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["action", "target", "body"],
                },
                {
                  type: "object",
                  properties: {
                    action: { type: "string", const: "replace" },
                    target: { type: "string" },
                    find: { type: "string" },
                    replaceWith: { type: "string" },
                  },
                  required: ["action", "target", "find", "replaceWith"],
                },
              ],
              additionalProperties: false,
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain('"sdk":"shell","client":"run_command"');
    expect(prepared.prompt.text).toContain('"sdk":"write","client":"workspace_file"');

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: prepared.tools,
      toolCalls: [
        {
          name: "shell",
          arguments: {
            command: "npm run build",
            workingDirectory: "/workspace",
            timeout: 120_000,
          },
        },
        {
          name: "write",
          arguments: {
            path: "src/App.jsx",
            fileText: "export default function App() { return null }",
          },
        },
        {
          name: "edit",
          arguments: {
            path: "src/App.jsx",
            oldString: "return null",
            newString: "return <main />",
          },
        },
      ],
      context: { workingDirectory: "/tmp/composed-app" },
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "run_command",
      "workspace_file",
      "workspace_file",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        shellCommand: "npm run build",
        timeoutSeconds: 120,
      },
      {
        action: "create",
        target: "src/App.jsx",
        body: "export default function App() { return null }",
      },
      {
        action: "replace",
        target: "src/App.jsx",
        find: "return null",
        replaceWith: "return <main />",
      },
    ]);
  });

  it("maps SDK calls through local JSON schema references", () => {
    const prepared = prepareOpencodeSdkChatRequest(
      {
        model: "composer-2.5-sdk",
        messages: [{ role: "user", content: "write the referenced schema file" }],
        tools: [
          {
            name: "workspace_file",
            parameters: {
              $ref: "#/$defs/FileInput",
              $defs: {
                FileInput: {
                  type: "object",
                  properties: {
                    operation: { $ref: "#/$defs/FileOperation" },
                    absolutePath: {
                      type: "string",
                      description: "absolute path to the file",
                    },
                    text: { type: "string" },
                  },
                  required: ["operation", "absolutePath", "text"],
                  additionalProperties: false,
                },
                FileOperation: {
                  type: "string",
                  enum: ["create", "replace", "read"],
                },
              },
            },
          },
        ],
      },
      { id: "composer-2.5-sdk" },
    );

    expect(prepared.prompt.text).toContain('"sdk":"write","client":"workspace_file"');

    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: prepared.tools,
      context: { workingDirectory: "/tmp/ref-schema-app" },
      toolCalls: [
        {
          name: "write",
          arguments: {
            path: "src/App.jsx",
            fileText: "export default function App() { return <main>Ref</main> }",
          },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual(["workspace_file"]);
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      operation: "create",
      absolutePath: "/tmp/ref-schema-app/src/App.jsx",
      text: "export default function App() { return <main>Ref</main> }",
    });
  });

  it("maps SDK calls to generic harness schemas by reusable tool shape", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
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
      ],
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
        { name: "shell", arguments: { command: "npm test", workingDirectory: "src" } },
        {
          name: "glob",
          arguments: { globPattern: "**/*.tsx", targetDirectory: "src" },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "workspace_file",
      "workspace_file",
      "run_command",
      "discover_files",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        action: "write",
        target: "src/App.tsx",
        body: "export default function App() { return null }",
      },
      {
        action: "replace",
        target: "src/App.tsx",
        find: "return null",
        replaceWith: "return <main />",
      },
      { shellCommand: "npm test", dir: "src" },
      { includePattern: "**/*.tsx", dir: "src" },
    ]);
  });

  it("maps Cursor SDK MCP calls to OpenCode server_tool functions", () => {
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
              overwrite: { type: "boolean" },
            },
            required: ["file_path", "contents"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "probe",
            toolName: "write_file",
            args: {
              file_path: "src/App.tsx",
              contents: "export default function App() { return null }",
              overwrite: true,
            },
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("probe_write_file");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      file_path: "src/App.tsx",
      contents: "export default function App() { return null }",
      overwrite: true,
    });
  });

  it("maps Cursor SDK MCP calls with alternate payload envelopes", () => {
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
              overwrite: { type: "boolean" },
            },
            required: ["file_path", "contents"],
          },
        },
        {
          name: "call_mcp_tool",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              serverName: { type: "string" },
              toolName: { type: "string" },
              input: { type: "object" },
            },
            required: ["serverName", "toolName", "input"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            serverName: "probe",
            name: "write_file",
            arguments: JSON.stringify({
              file_path: "src/App.tsx",
              contents: "export default function App() { return null }",
              overwrite: true,
            }),
          },
        },
        {
          name: "mcp",
          arguments: {
            provider: "filesystem",
            tool: "read_file",
            parameters: JSON.stringify({ path: "README.md" }),
          },
        },
      ],
    });

    expect(toolCalls.map((call) => call.function.name)).toEqual([
      "probe_write_file",
      "call_mcp_tool",
    ]);
    expect(toolCalls.map((call) => JSON.parse(call.function.arguments))).toEqual([
      {
        file_path: "src/App.tsx",
        contents: "export default function App() { return null }",
        overwrite: true,
      },
      {
        serverName: "filesystem",
        toolName: "read_file",
        input: { path: "README.md" },
      },
    ]);
  });

  it("maps Cursor SDK MCP calls to single-word client tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "webfetch",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              url: { type: "string" },
              format: { type: "string" },
            },
            required: ["url"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "webfetch",
            args: {
              url: "https://example.com",
              format: "markdown",
            },
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("webfetch");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      url: "https://example.com",
      format: "markdown",
    });
  });

  it("maps Cursor SDK MCP calls to wrapped single-word client tools", () => {
    const toolCalls = toOpenAiToolCalls({
      responseId: "chatcmpl_test",
      tools: [
        {
          name: "task",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              input: {
                type: "object",
                additionalProperties: false,
                properties: {
                  description: { type: "string" },
                  prompt: { type: "string" },
                  subagent_type: { type: "string" },
                },
                required: ["description", "prompt", "subagent_type"],
              },
            },
            required: ["input"],
          },
        },
      ],
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            providerIdentifier: "client",
            toolName: "task",
            args: {
              description: "Explore files",
              prompt: "Find the app entrypoint",
              subagent_type: "explore",
            },
          },
        },
      ],
    });

    expect(toolCalls[0].function.name).toBe("task");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      input: {
        description: "Explore files",
        prompt: "Find the app entrypoint",
        subagent_type: "explore",
      },
    });
  });
});
