import { spawn, exec, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { findAvailableLocalPort } from "./port-finder.js";
import {
  ChromeLaunchError,
  type ChromeLaunchOptions,
  type ChromeProcess,
} from "./types.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export class ChromeLauncher {
  private readonly defaultUserDataRoot: string;

  constructor(defaultUserDataRoot?: string) {
    if (defaultUserDataRoot) {
      this.defaultUserDataRoot = defaultUserDataRoot;
    } else if (process.platform === "win32") {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      this.defaultUserDataRoot = path.join(
        localAppData,
        "Connexto",
        "BrowserBridge",
        "profiles",
      );
    } else {
      this.defaultUserDataRoot = path.join(
        os.tmpdir(),
        "connexto-browser-bridge",
        "profiles",
      );
    }
  }

  public resolveChromeExecutable(overridePath?: string): string {
    if (overridePath) {
      if (fs.existsSync(overridePath)) {
        return overridePath;
      }
      throw new ChromeLaunchError(
        `Configured Chrome executable does not exist at: ${overridePath}`,
      );
    }

    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
      return process.env.CHROME_PATH;
    }

    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const programFilesX86 =
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

      const candidates = [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(
          programFilesX86,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } else if (process.platform === "darwin") {
      const macPath =
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (fs.existsSync(macPath)) {
        return macPath;
      }
    } else {
      const linuxCandidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
      for (const candidate of linuxCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    throw new ChromeLaunchError(
      "Google Chrome executable could not be found. Please configure CHROME_PATH.",
    );
  }

  public resolveSessionUserDataDir(
    sessionId: string,
    customRoot?: string,
  ): string {
    const root = customRoot || this.defaultUserDataRoot;
    const sessionDir = path.resolve(root, sessionId);

    this.assertNotPersonalProfile(sessionDir);
    return sessionDir;
  }

  public resolvePrincipalUserDataDir(
    principalId: string,
    customRoot?: string,
  ): string {
    const root = customRoot || this.defaultUserDataRoot;
    const sanitized = principalId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const profileDir = path.resolve(root, sanitized);

    this.assertNotPersonalProfile(profileDir);
    return profileDir;
  }

  public assertNotPersonalProfile(dirPath: string): void {
    const normalized = path.resolve(dirPath).toLowerCase();

    if (process.platform === "win32") {
      const localAppData = (
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      ).toLowerCase();
      const personalProfile = path.resolve(
        localAppData,
        "Google",
        "Chrome",
        "User Data",
      );
      if (
        normalized === personalProfile ||
        normalized.startsWith(personalProfile + path.sep)
      ) {
        throw new ChromeLaunchError(
          `Security violation: Attempted to use the personal Chrome profile at ${dirPath}`,
        );
      }
    }
  }

  public async launch(
    sessionId: string,
    options: ChromeLaunchOptions = {},
  ): Promise<ChromeProcess> {
    const maxAttempts = options.port !== undefined ? 1 : 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.launchAttempt(sessionId, options);
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts) {
          break;
        }
        // Small backoff before retrying with a fresh port
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    throw lastError instanceof ChromeLaunchError
      ? lastError
      : new ChromeLaunchError(
          `Failed to launch Chrome for session ${sessionId} after ${maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          { cause: lastError },
        );
  }

  private async launchAttempt(
    sessionId: string,
    options: ChromeLaunchOptions,
  ): Promise<ChromeProcess> {
    const executablePath = this.resolveChromeExecutable(options.executablePath);
    const port = options.port ?? (await findAvailableLocalPort());
    const userDataDir =
      options.userDataDir ??
      this.resolveSessionUserDataDir(
        sessionId,
        options.userDataDirRoot,
      );

    fs.mkdirSync(userDataDir, { recursive: true });

    const targetUrl = options.targetUrl ?? "about:blank";
    const args: string[] = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
    ];

    if (options.headless) {
      args.push("--headless=new");
    }

    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    args.push(targetUrl);

    let child: ChildProcess | undefined;
    try {
      child = spawn(executablePath, args, {
        detached: false,
        stdio: "ignore",
      });

      const pid = child.pid;
      if (!pid) {
        throw new ChromeLaunchError("Chrome process failed to spawn (no PID)");
      }
      const spawnedChild = child;

      let exitedEarly = false;
      let exitCode: number | null = null;
      spawnedChild.once("exit", (code) => {
        exitedEarly = true;
        exitCode = code;
      });

      const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
      const cdpInfo = await this.waitForCdpReady(port, timeoutMs, () => {
        if (exitedEarly) {
          const detail =
            exitCode === 0
              ? "Chrome process delegated to an already-running instance (code 0). Please close any open Chrome window using this profile before starting a new session."
              : `Chrome process exited prematurely with code ${exitCode}`;
          throw new ChromeLaunchError(detail);
        }
      });

      let isClosed = false;
      const close = async (): Promise<void> => {
        if (isClosed) {
          return;
        }
        isClosed = true;

        await this.terminateProcess(spawnedChild, pid);
      };

      const isAlive = (): boolean => {
        if (isClosed || spawnedChild.killed || spawnedChild.exitCode !== null) {
          return false;
        }
        try {
          // Sending signal 0 checks for process existence without killing it
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      return {
        processId: pid,
        port,
        userDataDir,
        wsEndpoint: cdpInfo.webSocketDebuggerUrl,
        close,
        isAlive,
      };
    } catch (error) {
      if (child) {
        try {
          if (child.pid) {
            process.kill(child.pid);
          }
        } catch {
          // Best effort cleanup
        }
      }
      throw error instanceof ChromeLaunchError
        ? error
        : new ChromeLaunchError(
            `Failed to launch Chrome for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
    }
  }

  private async waitForCdpReady(
    port: number,
    timeoutMs: number,
    checkEarlyExit: () => void,
  ): Promise<{ browser: string; webSocketDebuggerUrl: string }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      checkEarlyExit();

      try {
        const versionData = await this.queryCdpVersion(port);
        if (versionData && versionData.webSocketDebuggerUrl) {
          return {
            browser: versionData.Browser,
            webSocketDebuggerUrl: versionData.webSocketDebuggerUrl,
          };
        }
      } catch {
        // Retry until timeout
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new ChromeLaunchError(
      `Timed out waiting for Chrome CDP on 127.0.0.1:${port} after ${timeoutMs}ms`,
    );
  }

  private queryCdpVersion(
    port: number,
  ): Promise<{ Browser: string; webSocketDebuggerUrl: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/json/version",
          timeout: 1000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(
              new Error(`CDP responded with status ${res.statusCode}`),
            );
          }

          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data) as {
                Browser: string;
                webSocketDebuggerUrl: string;
              };
              resolve(parsed);
            } catch (parseErr) {
              reject(
                parseErr instanceof Error
                  ? parseErr
                  : new Error(String(parseErr)),
              );
            }
          });
        },
      );

      req.on("error", (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("CDP version request timed out"));
      });
    });
  }

  private async terminateProcess(
    child: ChildProcess,
    pid: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (child.killed || child.exitCode !== null) {
        return resolve();
      }

      let exited = false;
      const onExit = () => {
        if (!exited) {
          exited = true;
          resolve();
        }
      };

      child.once("exit", onExit);

      // Attempt graceful kill
      try {
        child.kill();
      } catch {
        // Fallback
      }

      // Hard kill fallback after 2.5 seconds
      setTimeout(() => {
        if (!exited) {
          try {
            if (process.platform === "win32") {
              exec(`taskkill /F /T /PID ${pid}`, () => onExit());
            } else {
              process.kill(pid, "SIGKILL");
              onExit();
            }
          } catch {
            onExit();
          }
        }
      }, 2500);
    });
  }
}
