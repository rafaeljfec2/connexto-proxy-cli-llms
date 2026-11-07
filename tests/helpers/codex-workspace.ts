/** Codex-like IDE context embedded in chat/responses payloads for integration tests. */
export const CODEX_TEST_WORKING_DIRECTORY = "/tmp/codex-agent-project";

export const codexWorkspaceSystemMessage = {
  role: "system" as const,
  content: [
    "Environment:",
    `  Working directory: ${CODEX_TEST_WORKING_DIRECTORY}`,
    `  Workspace root folder: ${CODEX_TEST_WORKING_DIRECTORY}`,
  ].join("\n"),
};

export const codexWorkspaceInstructions = [
  "Environment:",
  `  Working directory: ${CODEX_TEST_WORKING_DIRECTORY}`,
  `  Workspace root folder: ${CODEX_TEST_WORKING_DIRECTORY}`,
].join("\n");
