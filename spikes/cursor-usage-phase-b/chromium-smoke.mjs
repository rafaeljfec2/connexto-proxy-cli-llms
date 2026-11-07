import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext();
const page = await context.newPage();
await page.goto("about:blank");
const version = await browser.version();

await browser.close();

console.log(
  JSON.stringify({
    ok: true,
    playwrightCore: "1.50.1",
    chromiumExecutablePath: executablePath,
    browserVersion: version,
  }),
);
