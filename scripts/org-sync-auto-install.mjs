#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_PROJECTS_ROOT = "/Users/chandan/Desktop/projects";
const LABEL = "dev.upandup.org-sync-auto";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(scriptDir, "org-sync-auto-runner.mjs");

function usage() {
  return `Install macOS LaunchAgent for once-per-day org-sync-all across *_org folders.

Usage:
  npm run org:auto:install
  npm run org:auto:install -- --dry-run
  npm run org:auto:install -- --founder-args '--research'
  npm run org:auto:install -- --org-args '--since "1 day ago" --no-pull --no-llm' --founder-args '--no-llm'

Options:
  --projects-root <path>  Folder containing *_org folders. Default: ${DEFAULT_PROJECTS_ROOT}.
  --org-root <path>       Back-compat alias; uses the parent folder as projects root.
  --interval <seconds>    LaunchAgent interval. Default: 1800.
  --org-args <args>       Auto org-sync args. Default: --since "1 day ago" --no-pull.
  --founder-args <args>   Auto founder-sync args. Default: empty; founder-sync invokes OpenCode by default.
  --disable-founder       Run only org-sync automatically.
  --dry-run               Print plist and commands without installing.
  --help                  Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    interval: 1800,
    orgArgs: '--since "1 day ago" --no-pull',
    founderArgs: "",
    disableFounder: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    const nextRaw = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg.startsWith("--org-args=")) {
      options.orgArgs = arg.slice("--org-args=".length);
      continue;
    }
    if (arg.startsWith("--founder-args=")) {
      options.founderArgs = arg.slice("--founder-args=".length);
      continue;
    }
    switch (arg) {
      case "--org-root":
        options.projectsRoot = path.dirname(path.resolve(next()));
        break;
      case "--projects-root":
        options.projectsRoot = path.resolve(next());
        break;
      case "--interval": {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 60) throw new Error("--interval must be at least 60 seconds");
        options.interval = parsed;
        break;
      }
      case "--org-args":
        options.orgArgs = nextRaw();
        break;
      case "--founder-args":
        options.founderArgs = nextRaw();
        break;
      case "--disable-founder":
        options.disableFounder = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.stateDir = path.join(options.projectsRoot, ".org-intel-global");
  options.plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  return options;
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function envKeyValue(key, value) {
  return `\n      <key>${key}</key>\n      <string>${escapeXml(value)}</string>`;
}

function buildPlist(options) {
  const env = [
    envKeyValue("ORG_SYNC_AUTO_PROJECTS_ROOT", options.projectsRoot),
    envKeyValue("ORG_SYNC_AUTO_ORG_ARGS", options.orgArgs),
    envKeyValue("ORG_SYNC_AUTO_FOUNDER_ARGS", options.founderArgs),
  ];
  if (options.disableFounder) env.push(envKeyValue("ORG_SYNC_AUTO_DISABLE_FOUNDER", "1"));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(runnerPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.projectsRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>${env.join("")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${options.interval}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(options.stateDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(options.stateDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function launchctl(args, dryRun) {
  const command = `launchctl ${args.join(" ")}`;
  if (dryRun) {
    console.log(command);
    return { status: 0, stderr: "" };
  }
  const result = spawnSync("launchctl", args, { encoding: "utf8", stdio: "pipe" });
  const stderr = (result.stderr || "").trim();
  return { status: result.status ?? 1, stderr };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (process.platform !== "darwin") throw new Error("LaunchAgent install is only supported on macOS.");
  if (!existsSync(options.projectsRoot)) throw new Error(`Projects root does not exist: ${options.projectsRoot}`);

  const plist = buildPlist(options);
  console.log(`Plist: ${options.plistPath}`);
  console.log(`Projects root: ${options.projectsRoot}`);
  console.log(`Interval: ${options.interval}s`);

  if (options.dryRun) {
    console.log("\n--- plist ---\n" + plist);
    console.log("--- launchctl commands ---");
    launchctl(["bootout", `gui/${process.getuid()}`, options.plistPath], true);
    launchctl(["bootstrap", `gui/${process.getuid()}`, options.plistPath], true);
    return;
  }

  await mkdir(path.dirname(options.plistPath), { recursive: true });
  await mkdir(options.stateDir, { recursive: true });
  await writeFile(options.plistPath, plist, "utf8");

  const bootoutResult = launchctl(["bootout", `gui/${process.getuid()}`, options.plistPath], false);
  if (bootoutResult.status !== 0) {
    console.warn(`bootout warning (exit ${bootoutResult.status}): ${bootoutResult.stderr || "service may not have been loaded"}`);
  }

  const bootstrapResult = launchctl(["bootstrap", `gui/${process.getuid()}`, options.plistPath], false);
  if (bootstrapResult.status !== 0) {
    throw new Error(`bootstrap failed (exit ${bootstrapResult.status}): ${bootstrapResult.stderr || "unknown error"}`);
  }

  console.log("Installed org-sync auto LaunchAgent.");
}

main().catch((error) => {
  console.error(`org-sync-auto install failed: ${error.message}`);
  process.exitCode = 1;
});
