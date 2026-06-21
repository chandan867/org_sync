#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_PROJECTS_ROOT = "/Users/chandan/Desktop/projects";
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.dirname(scriptDir);

function usage() {
  return `org-sync-auto: run org-sync-all once per local day across *_org folders.

Usage:
  org-sync-auto
  org-sync-auto --dry-run
  npm run org:auto:run -- --dry-run

Options:
  --projects-root <path>  Folder containing *_org folders. Default: ${DEFAULT_PROJECTS_ROOT}.
  --org-args <args>       Extra org-sync args. Default: --since "1 day ago" --no-pull.
  --founder-args <args>   Extra founder-sync args. Default: empty; founder-sync invokes OpenCode by default.
  --disable-founder       Run org-sync only for each org.
  --force                 Run even if today's success stamp exists.
  --dry-run               Print planned commands without running or writing state.
  --help                  Show this help.

Environment overrides:
  ORG_SYNC_AUTO_PROJECTS_ROOT
  ORG_SYNC_AUTO_ORG_ARGS
  ORG_SYNC_AUTO_FOUNDER_ARGS
  ORG_SYNC_AUTO_DISABLE_FOUNDER=1
  ORG_SYNC_AUTO_STAMP_DIR
  ORG_SYNC_AUTO_LOG_DIR
`;
}

function parseArgs(argv) {
  const options = {
    projectsRoot: process.env.ORG_SYNC_AUTO_PROJECTS_ROOT || DEFAULT_PROJECTS_ROOT,
    orgArgs: process.env.ORG_SYNC_AUTO_ORG_ARGS || '--since "1 day ago" --no-pull',
    founderArgs: process.env.ORG_SYNC_AUTO_FOUNDER_ARGS || "",
    disableFounder: process.env.ORG_SYNC_AUTO_DISABLE_FOUNDER === "1",
    force: false,
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
      case "--projects-root":
        options.projectsRoot = path.resolve(next());
        break;
      case "--org-root":
        options.projectsRoot = path.dirname(path.resolve(next()));
        break;
      case "--org-args":
        options.orgArgs = nextRaw();
        break;
      case "--founder-args":
        options.founderArgs = nextRaw();
        break;
      case "--disable-founder":
        options.disableFounder = true;
        break;
      case "--force":
        options.force = true;
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

  options.stampDir = process.env.ORG_SYNC_AUTO_STAMP_DIR || path.join(options.projectsRoot, ".org-intel-global");
  options.logDir = process.env.ORG_SYNC_AUTO_LOG_DIR || path.join(options.stampDir, "logs");
  options.stampPath = path.join(options.stampDir, "last-successful-run");
  options.lockPath = path.join(options.stampDir, "running.lock");
  options.logPath = path.join(options.logDir, `${localDateKey(new Date())}.log`);
  return options;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  for (const char of command.trim()) {
    if ((char === "'" || char === '"') && quote === null) quote = char;
    else if (char === quote) quote = null;
    else if (/\s/.test(char) && quote === null) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else current += char;
  }
  if (current) words.push(current);
  return words;
}

function commandText(cmd, args) {
  return [cmd, ...args.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg)].join(" ");
}

async function appendLog(options, message) {
  if (options.dryRun) return;
  await mkdir(options.logDir, { recursive: true });
  await writeFile(options.logPath, `${message}\n`, { flag: "a" });
}

async function runCommand(label, cmd, args, options) {
  const text = commandText(cmd, args);
  console.log(`${label}: ${text}`);
  await appendLog(options, `\n[${new Date().toISOString()}] ${label}: ${text}`);
  if (options.dryRun) return { ok: true };

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.projectsRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", async (error) => {
      await appendLog(options, `ERROR: ${error.message}`);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", async (code) => {
      if (stdout.trim()) await appendLog(options, stdout.trimEnd());
      if (stderr.trim()) await appendLog(options, stderr.trimEnd());
      await appendLog(options, `[exit ${code}] ${label}`);
      resolve({ ok: code === 0, code });
    });
  });
}

async function alreadyRanToday(options) {
  if (!existsSync(options.stampPath)) return false;
  const stamp = (await readFile(options.stampPath, "utf8")).trim();
  return stamp === localDateKey(new Date());
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(options) {
  await mkdir(options.stampDir, { recursive: true });

  const lockPayload = `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`;

  try {
    const handle = await open(options.lockPath, "wx");
    await handle.writeFile(lockPayload, "utf8");
    await handle.close();
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  const lockText = await readFile(options.lockPath, "utf8").catch(() => "");
  const pid = Number.parseInt(/pid=(\d+)/.exec(lockText)?.[1] || "0", 10);
  const s = await stat(options.lockPath).catch(() => null);
  const isFresh = s ? Date.now() - s.mtimeMs < LOCK_STALE_MS : false;

  if (pid && pidIsAlive(pid) && isFresh) return false;

  await rm(options.lockPath, { force: true });

  try {
    const handle = await open(options.lockPath, "wx");
    await handle.writeFile(lockPayload, "utf8");
    await handle.close();
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false;
  }
}

async function releaseLock(options) {
  await rm(options.lockPath, { force: true });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const orgSyncAllScript = path.join(toolRoot, "scripts", "org-sync-all.mjs");
  const today = localDateKey(new Date());

  console.log(`Projects root: ${options.projectsRoot}`);
  console.log(`Stamp: ${options.stampPath}`);
  console.log(`Log: ${options.logPath}`);
  console.log(`Today: ${today}`);

  if (!options.force && await alreadyRanToday(options)) {
    console.log("Already ran successfully today. Use --force to run again.");
    return;
  }

  if (options.dryRun) {
    console.log("Dry run only. Planned commands:");
    const allArgs = [orgSyncAllScript, "--projects-root", options.projectsRoot, "--org-args", options.orgArgs];
    if (options.disableFounder) allArgs.push("--no-founder");
    else if (options.founderArgs) allArgs.push("--founder-args", options.founderArgs);
    console.log(commandText(process.execPath, allArgs));

    const cleanupScript = path.join(toolRoot, "scripts", "org-sync-cleanup.mjs");
    const cleanupArgs = [cleanupScript, "--projects-root", options.projectsRoot, "--no-keep-all-today", "--dry-run"];
    console.log(commandText(process.execPath, cleanupArgs));
    return;
  }

  const locked = await acquireLock(options);
  if (!locked) {
    console.log("Another auto sync appears to be running. Exiting.");
    return;
  }

  try {
    await appendLog(options, `\n=== org-sync-auto ${new Date().toISOString()} ===`);
    const allArgs = [orgSyncAllScript, "--projects-root", options.projectsRoot, "--org-args", options.orgArgs];
    if (options.disableFounder) allArgs.push("--no-founder");
    else if (options.founderArgs) allArgs.push("--founder-args", options.founderArgs);
    const result = await runCommand("org-sync-all", process.execPath, allArgs, options);
    if (!result.ok) throw new Error("org-sync-all failed; see auto log");

    const cleanupScript = path.join(toolRoot, "scripts", "org-sync-cleanup.mjs");
    const cleanupArgs = [cleanupScript, "--projects-root", options.projectsRoot, "--no-keep-all-today"];
    if (options.dryRun) {
      console.log(`Cleanup (dry-run): ${commandText(process.execPath, [...cleanupArgs, "--dry-run"])}`);
    } else {
      const cleanupResult = await runCommand("org-sync-cleanup", process.execPath, [...cleanupArgs, "--no-dry-run"], options);
      if (!cleanupResult.ok) {
        throw new Error(`org-sync-cleanup failed (${cleanupResult.code}): ${cleanupResult.stderr || cleanupResult.error || "unknown"}`);
      }
      if (cleanupResult.stdout && cleanupResult.stdout.includes("DELETED:")) {
        console.log("Cleanup removed duplicate run directories.");
      }
    }

    await writeFile(options.stampPath, `${today}\n`, "utf8");
    await appendLog(options, `success=${today}`);
    console.log("Auto sync complete.");
  } finally {
    await releaseLock(options);
  }
}

main().catch(async (error) => {
  console.error(`org-sync-auto failed: ${error.message}`);
  process.exitCode = 1;
});
