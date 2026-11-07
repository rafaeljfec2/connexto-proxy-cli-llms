import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { StorageState } from "./types.js";
import { chromium } from "playwright-core";

export interface PlaywrightBrowserOptions {
  readonly chromiumExecutablePath?: string;
  /** When false, opens a visible Chromium window for interactive Cursor OAuth (local dev). */
  readonly authHeadless?: boolean;
  /** Root directory for per-account Chrome profiles during interactive auth. */
  readonly authUserDataDirRoot?: string;
  readonly authViewportWidth?: number;
  readonly authViewportHeight?: number;
}

const DEFAULT_AUTH_VIEWPORT_WIDTH = 1024;
const DEFAULT_AUTH_VIEWPORT_HEIGHT = 768;
/** Approximate Chrome UI chrome (toolbars) above the page viewport. */
const AUTH_WINDOW_CHROME_INSET_PX = 96;

async function readAvailableScreen(page: Page): Promise<{ width: number; height: number }> {
  try {
    return await page.evaluate(() => {
      const screenInfo = (
        globalThis as unknown as { screen: { availWidth: number; availHeight: number } }
      ).screen;
      return { width: screenInfo.availWidth, height: screenInfo.availHeight };
    });
  } catch {
    return { width: 1920, height: 1080 };
  }
}

function centerWindowOnScreen(
  screenWidth: number,
  screenHeight: number,
  windowWidth: number,
  windowHeight: number,
): { left: number; top: number } {
  const left = Math.max(0, Math.floor((screenWidth - windowWidth) / 2));
  const top = Math.max(0, Math.floor((screenHeight - windowHeight) / 2));
  return { left, top };
}

async function fitAuthWindowToViewport(
  page: Page,
  viewportWidth: number,
  viewportHeight: number,
): Promise<void> {
  const windowWidth = viewportWidth;
  const windowHeight = viewportHeight + AUTH_WINDOW_CHROME_INSET_PX;
  const screen = await readAvailableScreen(page);
  const { left, top } = centerWindowOnScreen(
    screen.width,
    screen.height,
    windowWidth,
    windowHeight,
  );
  try {
    const client = await page.context().newCDPSession(page);
    const { windowId } = await client.send("Browser.getWindowForTarget");
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left,
        top,
        width: windowWidth,
        height: windowHeight,
        windowState: "normal",
      },
    });
  } catch {
    // Best effort: --window-size may still apply on some hosts.
  }
  await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
}

export interface LiveAuthContext {
  readonly context: BrowserContext;
  readonly page: Page;
}

export class PlaywrightBrowserPool {
  private browser: Browser | undefined;
  private readonly contexts = new Map<string, LiveAuthContext>();
  private readonly sessionAccounts = new Map<string, string>();
  private readonly executablePath?: string;
  private readonly authHeadless: boolean;
  private readonly authUserDataDirRoot?: string;
  private readonly authViewportWidth: number;
  private readonly authViewportHeight: number;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.executablePath = options.chromiumExecutablePath?.trim() || undefined;
    this.authHeadless = options.authHeadless !== false;
    const root = options.authUserDataDirRoot?.trim();
    this.authUserDataDirRoot = root && root.length > 0 ? root : undefined;
    this.authViewportWidth = options.authViewportWidth ?? DEFAULT_AUTH_VIEWPORT_WIDTH;
    this.authViewportHeight = options.authViewportHeight ?? DEFAULT_AUTH_VIEWPORT_HEIGHT;
  }

  public async ensureBrowser(): Promise<Browser> {
    if (this.browser !== undefined) {
      return this.browser;
    }
    try {
      this.browser = await chromium.launch({
        headless: true,
        executablePath: this.executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      return this.browser;
    } catch (error) {
      throw new BrowserUnavailableError(error);
    }
  }

  public hasActiveAuthForAccount(accountId: string): boolean {
    for (const sessionId of this.contexts.keys()) {
      if (this.sessionAccounts.get(sessionId) === accountId) {
        return true;
      }
    }
    return false;
  }

  private async closeAuthSessionsForAccount(accountId: string): Promise<void> {
    for (const sessionId of [...this.contexts.keys()]) {
      if (this.sessionAccounts.get(sessionId) === accountId) {
        await this.closeAuthSession(sessionId);
      }
    }
  }

  public async openAuthSession(
    sessionId: string,
    accountId: string,
    loginUrl: string,
  ): Promise<Page> {
    await this.closeAuthSessionsForAccount(accountId);
    if (!this.authHeadless) {
      const windowSize = `--window-size=${this.authViewportWidth},${this.authViewportHeight}`;
      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(
          this.resolveAuthProfileDir(accountId),
          {
            headless: false,
            executablePath: this.executablePath,
            args: [
              "--no-sandbox",
              "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled",
              "--force-device-scale-factor=1",
              windowSize,
            ],
            ignoreDefaultArgs: ["--enable-automation"],
            viewport: {
              width: this.authViewportWidth,
              height: this.authViewportHeight,
            },
          },
        );
      } catch (error) {
        throw new BrowserUnavailableError(error);
      }
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });
      const page = context.pages()[0] ?? (await context.newPage());
      await fitAuthWindowToViewport(page, this.authViewportWidth, this.authViewportHeight);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await fitAuthWindowToViewport(page, this.authViewportWidth, this.authViewportHeight);
      this.contexts.set(sessionId, { context, page });
      this.sessionAccounts.set(sessionId, accountId);
      return page;
    }

    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    this.contexts.set(sessionId, { context, page });
    this.sessionAccounts.set(sessionId, accountId);
    return page;
  }

  private resolveAuthProfileDir(accountId: string): string {
    const root =
      this.authUserDataDirRoot ??
      path.join(process.env.HOME ?? process.cwd(), ".connexto-proxy", "cursor-usage-auth");
    const safeAccount = accountId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "default";
    return path.join(root, safeAccount);
  }

  public hasAuthProfile(accountId: string): boolean {
    const profileDir = this.resolveAuthProfileDir(accountId);
    return (
      fs.existsSync(path.join(profileDir, "Local State")) ||
      fs.existsSync(path.join(profileDir, "Default"))
    );
  }

  private clearStaleProfileLocks(profileDir: string): void {
    const lockCandidates = [
      path.join(profileDir, "SingletonLock"),
      path.join(profileDir, "SingletonSocket"),
      path.join(profileDir, "SingletonCookie"),
      path.join(profileDir, "Default", "LOCK"),
      path.join(profileDir, "Default", "lockfile"),
    ];
    for (const lockPath of lockCandidates) {
      try {
        if (fs.existsSync(lockPath)) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch {
        // Profile may still be open in another process.
      }
    }
  }

  private async launchCollectPersistentContext(
    accountId: string,
  ): Promise<BrowserContext> {
    const profileDir = this.resolveAuthProfileDir(accountId);
    const launch = (): Promise<BrowserContext> =>
      chromium.launchPersistentContext(profileDir, {
        headless: true,
        executablePath: this.executablePath,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    try {
      return await launch();
    } catch (firstError) {
      this.clearStaleProfileLocks(profileDir);
      try {
        return await launch();
      } catch {
        throw new BrowserUnavailableError(firstError);
      }
    }
  }

  public async restoreAuthenticatedSession(
    accountId: string,
    storageState: StorageState,
  ): Promise<BrowserContext> {
    if (this.hasActiveAuthForAccount(accountId)) {
      throw new BrowserUnavailableError(
        new Error("interactive Cursor login is still open for this account"),
      );
    }
    const browser = await this.ensureBrowser();
    if (storageState.cookies.length > 0) {
      return browser.newContext({ storageState });
    }
    if (this.hasAuthProfile(accountId)) {
      return this.launchCollectPersistentContext(accountId);
    }
    return browser.newContext({ storageState });
  }

  public getLiveAuth(sessionId: string): LiveAuthContext | undefined {
    return this.contexts.get(sessionId);
  }

  public async closeAuthSession(sessionId: string): Promise<void> {
    const live = this.contexts.get(sessionId);
    if (live === undefined) {
      return;
    }
    this.contexts.delete(sessionId);
    this.sessionAccounts.delete(sessionId);
    await live.context.close();
  }

  public async pageHasUpstreamChallenge(page: Page): Promise<boolean> {
    return pageShowsUpstreamBlock(page);
  }

  public async captureStorageState(sessionId: string): Promise<StorageState> {
    const live = this.contexts.get(sessionId);
    if (live === undefined) {
      throw new Error("auth session not found");
    }
    return live.context.storageState();
  }

  /**
   * OAuth often lands on cursor.com/agents; usage APIs live on grok.com/dashboard.
   * Navigate there before capturing storageState or calling dashboard APIs.
   */
  public async primeCollectDashboard(params: {
    readonly context: BrowserContext;
    readonly dashboardUrl: string;
    readonly urlPattern: RegExp;
    readonly timeoutMs: number;
  }): Promise<void> {
    const timeout = Math.min(params.timeoutMs, 60_000);
    let page = params.context.pages()[0];
    if (page === undefined) {
      page = await params.context.newPage();
    }
    const current = page.url();
    if (
      /grok\.com\/dashboard/i.test(current) &&
      params.urlPattern.test(current)
    ) {
      return;
    }
    const responsePromise = page
      .waitForResponse(
        (response) =>
          params.urlPattern.test(response.url()) &&
          response.request().method() !== "OPTIONS",
        { timeout },
      )
      .catch(() => undefined);
    await page.goto(params.dashboardUrl, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    await responsePromise;
    if (await pageShowsUpstreamBlock(page)) {
      throw new ChallengeRequiredError();
    }
  }

  public async waitForUsageJson(params: {
    context: BrowserContext;
    dashboardUrl: string;
    urlPattern: RegExp;
    timeoutMs: number;
  }): Promise<unknown> {
    const page = await params.context.newPage();
    try {
      const responsePromise = page.waitForResponse(
        (response) =>
          params.urlPattern.test(response.url()) &&
          response.request().method() !== "OPTIONS",
        { timeout: params.timeoutMs },
      );
      await page.goto(params.dashboardUrl, {
        waitUntil: "domcontentloaded",
        timeout: params.timeoutMs,
      });
      const response = await responsePromise;
      if (!response.ok()) {
        if (response.status() === 401 || response.status() === 403) {
          throw new SessionExpiredError();
        }
        throw new CollectionFailedError(`upstream status ${response.status()}`);
      }
      return response.json();
    } finally {
      await page.close();
    }
  }

  public async shutdown(): Promise<void> {
    for (const sessionId of [...this.contexts.keys()]) {
      await this.closeAuthSession(sessionId);
    }
    if (this.browser !== undefined) {
      await this.browser.close();
      this.browser = undefined;
    }
  }
}

export class BrowserUnavailableError extends Error {
  constructor(cause: unknown) {
    super(browserUnavailableDetail(cause));
    this.name = "BrowserUnavailableError";
    this.cause = cause;
  }
}

export function browserUnavailableDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause.trim();
  }
  return "Chromium is unavailable";
}

export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

export class CollectionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionFailedError";
  }
}

export class ChallengeRequiredError extends Error {
  constructor() {
    super("upstream challenge required");
    this.name = "ChallengeRequiredError";
  }
}

async function pageShowsUpstreamBlock(page: Page): Promise<boolean> {
  try {
    const title = (await page.title()).toLowerCase();
    const html = (await page.content()).toLowerCase();
    const blob = `${title}\n${html}`;
    return (
      blob.includes("cloudflare") ||
      blob.includes("you have been blocked") ||
      blob.includes("attention required") ||
      blob.includes("unable to access x.ai")
    );
  } catch {
    return false;
  }
}
