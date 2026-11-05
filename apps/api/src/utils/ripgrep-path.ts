import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Cursor SDK local agents invoke ripgrep with flags (e.g. --no-require-git)
 * that require a recent rg. WSL often has /usr/bin/rg 11.x earlier on PATH.
 */
export function preferCompatibleRipgrepOnPath(): void {
  const configured = process.env.RIPGREP_PATH?.trim();
  if (configured !== undefined && configured.length > 0) {
    prependDir(path.dirname(configured));
    return;
  }

  try {
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    prependDir(path.dirname(rgPath));
  } catch {
    // @vscode/ripgrep not installed; keep existing PATH.
  }
}

function prependDir(directory: string): void {
  const current = process.env.PATH ?? "";
  if (current.split(path.delimiter).includes(directory)) {
    return;
  }
  process.env.PATH = `${directory}${path.delimiter}${current}`;
}
