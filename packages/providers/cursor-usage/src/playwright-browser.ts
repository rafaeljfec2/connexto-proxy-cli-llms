import type { Browser, BrowserContext, Page } from "playwright-core";
import type { StorageState } from "./types.js";
import { chromium } from "playwright-core";

export interface PlaywrightBrowserOptions {
  readonly chromiumExecutablePath?: string;
}

export interface LiveAuthContext {
  readonly context: BrowserContext;
  readonly page: Page;
}

export class PlaywrightBrowserPool {
  private browser: Browser | undefined;
  private readonly contexts = new Map<string, LiveAuthContext>();
  private readonly executablePath?: string;

  constructor(options: PlaywrightBrowserOptions = {}) {
    this.executablePath = options.chromiumExecutablePath?.trim() || undefined;
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

  public async openAuthSession(sessionId: string, loginUrl: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    this.contexts.set(sessionId, { context, page });
    return page;
  }

  public async restoreAuthenticatedSession(
    accountId: string,
    storageState: StorageState,
  ): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
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
    await live.context.close();
  }

  public async captureStorageState(sessionId: string): Promise<StorageState> {
    const live = this.contexts.get(sessionId);
    if (live === undefined) {
      throw new Error("auth session not found");
    }
    return live.context.storageState();
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
    super("Chromium is unavailable");
    this.name = "BrowserUnavailableError";
    this.cause = cause;
  }
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
