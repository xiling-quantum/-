import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_VIEWPORT = {
  width: 1440,
  height: 960
};

const DEFAULT_LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

export async function createBrowserSession(options) {
  const {
    headless,
    navigationTimeoutMs,
    storageStatePath,
    sessionMode = "storageState",
    persistentProfile
  } = options;

  let storageStateLoaded = false;
  let browser = null;
  let context;

  if (sessionMode === "persistentProfile") {
    const userDataDir = persistentProfile?.userDataDir;
    if (!userDataDir) {
      throw new Error("persistentProfile.userDataDir is required for persistentProfile sessions");
    }

    await fs.access(userDataDir);
    storageStateLoaded = true;
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel: persistentProfile?.channel || "chrome",
      args: [
        ...DEFAULT_LAUNCH_ARGS,
        ...(persistentProfile?.profileDirectory
          ? [`--profile-directory=${persistentProfile.profileDirectory}`]
          : [])
      ],
      locale: "en-US",
      viewport: DEFAULT_VIEWPORT
    });
    browser = context.browser();
  } else {
    let storageState = undefined;

    if (storageStatePath) {
      try {
        await fs.access(storageStatePath);
        storageState = storageStatePath;
        storageStateLoaded = true;
      } catch {
        storageStateLoaded = false;
      }
    }

    browser = await chromium.launch({
      headless,
      args: DEFAULT_LAUNCH_ARGS
    });

    context = await browser.newContext({
      storageState,
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: DEFAULT_VIEWPORT
    });
  }

  context.setDefaultTimeout(navigationTimeoutMs);
  context.setDefaultNavigationTimeout(navigationTimeoutMs);

  return {
    browser,
    context,
    storageStateLoaded,
    sessionModeUsed: sessionMode,
    async close() {
      await context.close();
      if (sessionMode !== "persistentProfile" && browser) {
        await browser.close();
      }
    }
  };
}

export async function saveStorageState(context, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await context.storageState({ path: targetPath });
}
