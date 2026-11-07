/**
 * Chromium flags for Cursor usage auth/collect.
 * Headed desktop: omit --no-sandbox (visible in Chrome UI; triggers Cloudflare / Google blocks).
 * Headless (Docker): keep --no-sandbox when required by the runtime.
 */
export function resolveChromiumNoSandbox(options: {
  readonly explicit?: boolean;
  readonly headless: boolean;
}): boolean {
  if (options.explicit !== undefined) {
    return options.explicit;
  }
  return options.headless;
}

export function buildChromiumLaunchArgs(
  noSandbox: boolean,
  extraArgs: readonly string[] = [],
): string[] {
  const args: string[] = [
    "--disable-blink-features=AutomationControlled",
    ...extraArgs,
  ];
  if (noSandbox) {
    args.unshift("--disable-dev-shm-usage", "--no-sandbox");
  }
  return args;
}
