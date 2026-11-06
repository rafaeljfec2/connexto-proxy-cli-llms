import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export const spawnProcess = spawn;

/**
 * Spawn signature the ACP transport needs. Streams are configured by the
 * caller (stdio [pipe, pipe, pipe]); streams may be null on some platforms,
 * so the transport guards stderr/stdout access.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;
