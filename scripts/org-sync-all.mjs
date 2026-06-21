#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProjectsRoot } from "./lib/org-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.dirname(scriptDir);

function usage() {
  return `org-sync-all: run org-sync/founder-sync across every *_org folder.

Usage:
  org-sync-all
  org-sync-all --dry-run
  org-sync-all --include upandup_org

Options:
  --projects-root <path>   Folder containing *_org folders. Default: cwd (or ORG_SYNC_PROJECTS_ROOT env).
  --include <org>          Include only this org folder name. Can be repeated.
  --exclude <org>          Exclude this org folder name. Can be repeated.
  --org-args <args>        Args passed to org-sync. Default: --since "1 day ago" --no-pull.
  --founder-args <args>    Args passed to founder-sync. Default: empty; founder-sync invokes OpenCode by default.
  --no-founder             Skip founder-sync for all orgs.
  --weekly                 After sync, run org-weekly-summary for each org.
  --weekly-args <args>     Args passed to org-weekly-summary. Default: empty.
  --dry-run                Print planned actions without running syncs or writing index.
  --help                   Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    projectsRoot: resolveProjectsRoot(null),
    includes: [],
    excludes: [],
    orgArgs: process.env.ORG_SYNC_ALL_ORG_ARGS || '--since "1 day ago" --no-pull',
    founderArgs: process.env.ORG_SYNC_ALL_FOUNDER_ARGS || "",
    founder: process.env.ORG_SYNC_ALL_NO_FOUNDER !== "1",
    weekly: process.env.ORG_SYNC_ALL_WEEKLY === "1",
    weeklyArgs: process.env.ORG_SYNC_ALL_WEEKLY_ARGS || "",
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
      case "--include":
        options.includes.push(next());
        break;
      case "--exclude":
        options.excludes.push(next());
        break;
      case "--org-args":
        options.orgArgs = nextRaw();
        break;
      case "--founder-args":
        options.founderArgs = nextRaw();
        break;
      case "--no-founder":
        options.founder = false;
        break;
      case "--weekly":
        options.weekly = true;
        break;
      case "--weekly-args":
        options.weeklyArgs = nextRaw();
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
  options.globalDir = path.join(options.projectsRoot, ".org-intel-global");
  return options;
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

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function commandText(cmd, args) {
  return [cmd, ...args.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg)].join(" ");
}

async function discoverOrgs(options) {
  const entries = await readdir(options.projectsRoot, { withFileTypes: true });
  const includeSet = new Set(options.includes);
  const excludeSet = new Set(options.excludes);
  const orgs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith("_org")) continue;
    if (includeSet.size && !includeSet.has(entry.name)) continue;
    if (excludeSet.has(entry.name)) continue;
    orgs.push({ name: entry.name, path: path.join(options.projectsRoot, entry.name) });
  }
  return orgs.sort((a, b) => a.name.localeCompare(b.name));
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, error: null }));
  });
}

async function latestRunDir(orgRoot) {
  const reportsDir = path.join(orgRoot, "org-sync-reports");
  if (!existsSync(reportsDir)) return null;
  const entries = await readdir(reportsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(reportsDir, entry.name, "report.md");
    if (!existsSync(reportPath)) continue;
    const s = await stat(reportPath);
    candidates.push({ dir: path.join(reportsDir, entry.name), reportPath, mtimeMs: s.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function writeGlobalIndexes(options, runSummary) {
  const date = localDateKey();
  const orgsDir = path.join(options.globalDir, "orgs");
  const dailyDir = path.join(options.globalDir, "daily");
  await mkdir(orgsDir, { recursive: true });
  await mkdir(dailyDir, { recursive: true });

  for (const org of runSummary.orgs) {
    await writeJson(path.join(orgsDir, `${org.name}.json`), org);
  }

  // Write daily snapshot (org-sync.mjs already updates index.json per-org; just archive the batch here)
  await writeJson(path.join(dailyDir, `${date}.json`), runSummary);
}

async function syncOrg(org, options) {
  const orgSyncScript = path.join(toolRoot, "scripts", "org-sync.mjs");
  const founderSyncScript = path.join(toolRoot, "scripts", "founder-sync.mjs");
  const orgArgs = [orgSyncScript, "--org-root", org.path, ...shellWords(options.orgArgs)];
  const founderArgs = [founderSyncScript, "--org-root", org.path, ...shellWords(options.founderArgs)];
  console.log(`\n[${org.name}] org-sync: ${commandText(process.execPath, orgArgs)}`);
  if (options.dryRun) {
    if (options.founder) console.log(`[${org.name}] founder-sync: ${commandText(process.execPath, founderArgs)}`);
    if (options.weekly) {
      const weeklyScript = path.join(toolRoot, "scripts", "org-weekly-summary.mjs");
      const weeklyArgs = [weeklyScript, "--org-root", org.path, ...shellWords(options.weeklyArgs)];
      console.log(`[${org.name}] org-weekly-summary: ${commandText(process.execPath, weeklyArgs)}`);
    }
    return { name: org.name, path: org.path, status: "planned", orgCommand: commandText(process.execPath, orgArgs), founderCommand: options.founder ? commandText(process.execPath, founderArgs) : null };
  }

  const orgResult = await run(process.execPath, orgArgs, org.path);
  const latest = await latestRunDir(org.path);
  const signalsPath = latest ? path.join(latest.dir, "founder-signals.json") : null;
  const signals = signalsPath ? await readJsonIfExists(signalsPath).catch(() => null) : null;
  const record = {
    name: org.name,
    path: org.path,
    status: orgResult.ok ? "org-synced" : "failed",
    orgCommand: commandText(process.execPath, orgArgs),
    orgExitCode: orgResult.code,
    reportPath: latest?.reportPath || null,
    founderSignalsPath: signalsPath,
    signals,
    founder: null,
    error: orgResult.ok ? null : (orgResult.stderr || orgResult.error || "org-sync failed").trim(),
  };

  if (!orgResult.ok) return record;

  const runWeekly = async () => {
    if (!options.weekly) return;
    const weeklyScript = path.join(toolRoot, "scripts", "org-weekly-summary.mjs");
    const weeklyArgs = [weeklyScript, "--org-root", org.path, ...shellWords(options.weeklyArgs)];
    console.log(`[${org.name}] org-weekly-summary: ${commandText(process.execPath, weeklyArgs)}`);
    const weeklyResult = await run(process.execPath, weeklyArgs, org.path);
    record.weekly = {
      ok: weeklyResult.ok,
      exitCode: weeklyResult.code,
      error: weeklyResult.ok ? null : (weeklyResult.stderr || weeklyResult.error || "org-weekly-summary failed").trim(),
    };
    if (!weeklyResult.ok) record.status = "weekly-failed";
  };

  if (!options.founder) {
    await runWeekly();
    return record;
  }

  console.log(`[${org.name}] founder-sync: ${commandText(process.execPath, founderArgs)}`);
  const founderResult = await run(process.execPath, founderArgs, org.path);
  const outputDate = localDateKey();
  const [year, month] = outputDate.split("-");
  const dailyPath = path.join(org.path, "vision", "daily", year, month, `${outputDate}.md`);
  const dailyExists = existsSync(dailyPath);
  record.founder = {
    ok: founderResult.ok && dailyExists,
    exitCode: founderResult.code,
    dailyPath,
    error: founderResult.ok
      ? dailyExists ? null : `founder-sync completed but expected daily output missing: ${dailyPath}`
      : (founderResult.stderr || founderResult.error || "founder-sync failed").trim(),
  };
  record.status = record.founder.ok ? "completed" : (founderResult.ok ? "founder-input-required" : "founder-failed");

  await runWeekly();

  return record;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const stats = await stat(options.projectsRoot).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Projects root does not exist: ${options.projectsRoot}`);
  const orgs = await discoverOrgs(options);
  console.log(`Projects root: ${options.projectsRoot}`);
  console.log(`Global index: ${options.globalDir}`);
  console.log(`Orgs: ${orgs.map((org) => org.name).join(", ") || "none"}`);
  if (!orgs.length) throw new Error(`No *_org folders found under ${options.projectsRoot}`);

  const runSummary = { schemaVersion: 1, generatedAt: new Date().toISOString(), projectsRoot: options.projectsRoot, orgs: [] };
  for (const org of orgs) {
    const result = await syncOrg(org, options);
    runSummary.orgs.push(result);
  }
  if (!options.dryRun) {
    await writeGlobalIndexes(options, runSummary);
    console.log(`\nDaily snapshot: ${path.join(options.globalDir, "daily")}`);
  }
  const failed = runSummary.orgs.filter((org) => !["completed", "org-synced", "planned", "founder-input-required"].includes(org.status) || org.weekly?.ok === false);
  if (failed.length) throw new Error(`One or more orgs failed: ${failed.map((org) => `${org.name}=${org.status}`).join(", ")}`);
}

main().catch((error) => {
  console.error(`org-sync-all failed: ${error.message}`);
  process.exitCode = 1;
});
