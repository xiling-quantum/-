import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { printAuthHelp } from "./core/args.js";
import { createBrowserSession, saveStorageState } from "./core/browser.js";
import { loadConfig } from "./core/config.js";

const AUTH_URLS = {
  tiktok: "https://www.tiktok.com/login",
  instagram: "https://www.instagram.com/accounts/login/"
};

function parseAuthArgs(argv) {
  const args = {
    platform: null,
    config: "./config/sources.example.json",
    sessionMode: null,
    userDataDir: null,
    profileDirectory: null,
    channel: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--platform") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --platform");
      }
      args.platform = next.toLowerCase();
      index += 1;
      continue;
    }
    if (current === "--config") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --config");
      }
      args.config = next;
      index += 1;
      continue;
    }
    if (current === "--session-mode") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --session-mode");
      }
      args.sessionMode = next;
      index += 1;
      continue;
    }
    if (current === "--user-data-dir") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --user-data-dir");
      }
      args.userDataDir = next;
      index += 1;
      continue;
    }
    if (current === "--profile-directory") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --profile-directory");
      }
      args.profileDirectory = next;
      index += 1;
      continue;
    }
    if (current === "--channel") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --channel");
      }
      args.channel = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  if (!args.help && !AUTH_URLS[args.platform]) {
    throw new Error("Auth platform must be one of: tiktok, instagram");
  }

  return args;
}

function resolveAuthSessionOptions(platformConfig, cliArgs) {
  return {
    storageStatePath: platformConfig.storageState,
    sessionMode: cliArgs.sessionMode || platformConfig.sessionMode || "storageState",
    persistentProfile: {
      ...platformConfig.persistentProfile,
      enabled:
        cliArgs.sessionMode === "persistentProfile"
          ? true
          : platformConfig.persistentProfile?.enabled,
      userDataDir: cliArgs.userDataDir || platformConfig.persistentProfile?.userDataDir || "",
      profileDirectory:
        cliArgs.profileDirectory ||
        platformConfig.persistentProfile?.profileDirectory ||
        "Default",
      channel: cliArgs.channel || platformConfig.persistentProfile?.channel || "chrome"
    }
  };
}

async function getOrCreatePage(context) {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function main() {
  let cliArgs;
  try {
    cliArgs = parseAuthArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printAuthHelp();
    process.exitCode = 1;
    return;
  }

  if (cliArgs.help) {
    printAuthHelp();
    return;
  }

  const config = await loadConfig(cliArgs.config);
  const platformConfig = config[cliArgs.platform];
  const authSession = resolveAuthSessionOptions(platformConfig, cliArgs);
  const session = await createBrowserSession({
    headless: false,
    navigationTimeoutMs: config.global.navigationTimeoutMs,
    storageStatePath: authSession.storageStatePath,
    sessionMode: authSession.sessionMode,
    persistentProfile: authSession.persistentProfile
  });
  const page = await getOrCreatePage(session.context);

  try {
    await page.goto(AUTH_URLS[cliArgs.platform], {
      waitUntil: "domcontentloaded"
    });

    console.log(`Browser opened for ${cliArgs.platform}.`);
    console.log(`Session mode: ${authSession.sessionMode}`);
    if (authSession.sessionMode === "persistentProfile") {
      console.log(
        `Using browser profile: ${authSession.persistentProfile.userDataDir} [${authSession.persistentProfile.profileDirectory}]`
      );
      console.log("Close the same Chrome/Edge profile first if the browser says the profile is locked.");
    }
    console.log("Complete the login flow in the browser window.");
    console.log("When the account home page is ready, press Enter here to save the session.");

    const rl = readline.createInterface({ input, output });
    await rl.question("");
    rl.close();

    await saveStorageState(session.context, authSession.storageStatePath);
    console.log(`Saved storage state to ${authSession.storageStatePath}`);
  } finally {
    await session.close();
  }
}

await main();
