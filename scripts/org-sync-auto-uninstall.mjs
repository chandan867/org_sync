#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_PROJECTS_ROOT = process.env.ORG_SYNC_PROJECTS_ROOT || process.env.ORG_SYNC_AUTO_PROJECTS_ROOT || process.cwd();
const LABEL = "dev.upandup.org-sync-auto";

function usage() {
  return `Uninstall macOS LaunchAgent for org-sync auto.

Usage:
  npm run org:auto:uninstall
  npm run org:auto:uninstall -- --purge-state

Options:
  --projects-root <path> Projects folder. Default: ${DEFAULT_PROJECTS_ROOT}.
  --org-root <path>      Back-compat alias; uses the parent folder as projects root.
  --purge-state       Remove <org-root>/.org-sync-auto logs/stamps too.
  --dry-run           Print actions without changing anything.
  --help              Show this help.
`;
}

function parseArgs(argv) {
  const options = { projectsRoot: DEFAULT_PROJECTS_ROOT, purgeState: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--org-root":
        options.projectsRoot = path.dirname(path.resolve(next()));
        break;
      case "--projects-root":
        options.projectsRoot = path.resolve(next());
        break;
      case "--purge-state":
        options.purgeState = true;
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
  options.plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  options.stateDir = path.join(options.projectsRoot, ".org-intel-global");
  return options;
}

function run(args, dryRun) {
  const text = `launchctl ${args.join(" ")}`;
  if (dryRun) {
    console.log(text);
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
  if (process.platform !== "darwin") throw new Error("LaunchAgent uninstall is only supported on macOS.");

  const bootoutResult = run(["bootout", `gui/${process.getuid()}`, options.plistPath], options.dryRun);
  if (bootoutResult.status !== 0) {
    console.warn(`bootout warning (exit ${bootoutResult.status}): ${bootoutResult.stderr || "service may not have been loaded"}`);
  }

  if (options.dryRun) {
    console.log(`rm ${options.plistPath}`);
    if (options.purgeState) console.log(`rm -rf ${options.stateDir}`);
    return;
  }

  if (existsSync(options.plistPath)) await rm(options.plistPath, { force: true });
  if (options.purgeState) await rm(options.stateDir, { force: true, recursive: true });
  console.log("Uninstalled org-sync auto LaunchAgent.");
}

main().catch((error) => {
  console.error(`org-sync-auto uninstall failed: ${error.message}`);
  process.exitCode = 1;
});
