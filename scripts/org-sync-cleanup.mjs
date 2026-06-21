#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_PROJECTS_ROOT = "/Users/chandan/Desktop/projects";
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_CONTENT_FILES = ["report.md", "run-summary.json"];

function parseArgs(argv) {
  const options = {
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    include: null,
    exclude: null,
    dryRun: true,
    keepAllToday: true,
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

    if (arg.startsWith("--include=")) {
      options.include = arg.slice("--include=".length).split(",").map(s => s.trim());
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      options.exclude = arg.slice("--exclude=".length).split(",").map(s => s.trim());
      continue;
    }

    switch (arg) {
      case "--projects-root":
        options.projectsRoot = path.resolve(next());
        break;
      case "--include":
        options.include = next().split(",").map(s => s.trim());
        break;
      case "--exclude":
        options.exclude = next().split(",").map(s => s.trim());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-dry-run":
        options.dryRun = false;
        break;
      case "--no-keep-all-today":
        options.keepAllToday = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `org-sync-cleanup: remove duplicate timestamped report directories in *_org folders.

For each local date group, keeps only the canonical run (highest repo count,
then fullest artifact set, then latest generatedAt). Deletes the rest.

Safety:
  - Only removes dirs under <org>/org-sync-reports matching strict timestamp regex.
  - Only removes dirs containing report.md or run-summary.json.
  - Validates path is within expected org structure.
  - Does not delete today's runs by default (use --no-keep-all-today).
  - Defaults to --dry-run; add --no-dry-run to actually delete.

Usage:
  org-sync-cleanup
  org-sync-cleanup --projects-root /path/to/projects --include upandup_org
  org-sync-cleanup --dry-run --no-keep-all-today
  org-sync-cleanup --no-dry-run

Options:
  --projects-root <path>   Folder containing *_org folders. Default: ${DEFAULT_PROJECTS_ROOT}.
  --include <names>        Comma-separated org folder names to include (e.g. upandup_org).
  --exclude <names>        Comma-separated org folder names to exclude.
  --dry-run                Print plan without deleting (default: true).
  --no-dry-run             Actually delete duplicate directories.
  --no-keep-all-today      Allow deleting today's duplicates (default: keep all today's runs).
  --help                   Show this help.
`;
}

function parseRunDate(runId) {
  const iso = `${runId.slice(0, 10)}T${runId.slice(11, 13)}:${runId.slice(14, 16)}:${runId.slice(17, 19)}.${runId.slice(20, 23)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function localDateFromRunId(runId) {
  const d = parseRunDate(runId);
  if (!d) return runId.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function discoverOrgs(projectsRoot, include, exclude) {
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith("_org"))
    .map((e) => e.name)
    .filter((name) => {
      if (include && include.length > 0) return include.includes(name);
      if (exclude && exclude.length > 0) return !exclude.includes(name);
      return true;
    })
    .sort();
}

async function discoverReportRuns(orgPath) {
  const reportsDir = path.join(orgPath, "org-sync-reports");
  if (!existsSync(reportsDir)) return [];
  const entries = await readdir(reportsDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && TIMESTAMP_RE.test(e.name)).map((e) => e.name);
  const validated = [];
  for (const dirName of dirs) {
    const fullPath = path.join(reportsDir, dirName);
    const relative = path.relative(reportsDir, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const hasSafeFile = await SAFE_CONTENT_FILES.reduce(async (accP, fileName) => {
      const acc = await accP;
      return acc || existsSync(path.join(fullPath, fileName));
    }, Promise.resolve(false));
    if (hasSafeFile) validated.push(dirName);
  }
  return validated.sort();
}

async function runSummaryRepoCount(orgPath, runId) {
  const summaryPath = path.join(orgPath, "org-sync-reports", runId, "run-summary.json");
  if (!existsSync(summaryPath)) return 0;
  try {
    const content = await readFile(summaryPath, "utf8");
    const data = JSON.parse(content);
    return (data.repos || []).length;
  } catch {
    return 0;
  }
}

function artifactCompleteness(orgPath, runId) {
  const dir = path.join(orgPath, "org-sync-reports", runId);
  let score = 0;
  if (existsSync(path.join(dir, "report.md"))) score += 1;
  if (existsSync(path.join(dir, "run-summary.json"))) score += 1;
  if (existsSync(path.join(dir, "founder-signals.json"))) score += 1;
  if (existsSync(path.join(dir, "deep-review-prompt.md"))) score += 1;
  if (existsSync(path.join(dir, "release-review-prompt.md"))) score += 1;
  if (existsSync(path.join(dir, "org-prompt.md"))) score += 1;
  return score;
}

async function generatedAtTime(orgPath, runId) {
  const summaryPath = path.join(orgPath, "org-sync-reports", runId, "run-summary.json");
  if (!existsSync(summaryPath)) return null;
  try {
    const content = await readFile(summaryPath, "utf8");
    const data = JSON.parse(content);
    return data.generatedAt || null;
  } catch {
    return null;
  }
}

async function canonicalRun(orgPath, runIds) {
  if (runIds.length === 0) return null;
  if (runIds.length === 1) return runIds[0];

  const scored = await Promise.all(
    runIds.map(async (id) => {
      const repoCount = await runSummaryRepoCount(orgPath, id);
      const completeness = artifactCompleteness(orgPath, id);
      const genAt = await generatedAtTime(orgPath, id);
      return { id, repoCount, completeness, genAt };
    })
  );

  scored.sort((a, b) => {
    if (b.repoCount !== a.repoCount) return b.repoCount - a.repoCount;
    if (b.completeness !== a.completeness) return b.completeness - a.completeness;
    if (a.genAt && b.genAt) return b.genAt.localeCompare(a.genAt);
    if (a.genAt) return -1;
    if (b.genAt) return 1;
    return b.id.localeCompare(a.id);
  });

  return scored[0].id;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const projectsRoot = options.projectsRoot;
  const todayStr = todayLocalDate();
  const totalPlan = [];

  console.log(`Projects root: ${projectsRoot}`);
  console.log(`Mode: ${options.dryRun ? "DRY RUN (no deletions)" : "LIVE (will delete)"}`);
  console.log(`Keep all today: ${options.keepAllToday}`);
  console.log("");

  const orgs = await discoverOrgs(projectsRoot, options.include, options.exclude);
  if (orgs.length === 0) {
    console.log("No *_org folders found.");
    return;
  }
  console.log(`Orgs: ${orgs.join(", ")}`);
  console.log("");

  for (const orgName of orgs) {
    const orgPath = path.join(projectsRoot, orgName);
    const runs = await discoverReportRuns(orgPath);

    if (runs.length === 0) {
      console.log(`[${orgName}] No report runs found.`);
      continue;
    }

    const byDate = {};
    for (const runId of runs) {
      const dateKey = localDateFromRunId(runId);
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(runId);
    }

    const dateKeys = Object.keys(byDate).sort();
    console.log(`[${orgName}] ${runs.length} runs across ${dateKeys.length} date(s)`);

    for (const dateKey of dateKeys) {
      const runIds = byDate[dateKey];
      if (runIds.length <= 1) continue;

      const canonicalId = await canonicalRun(orgPath, runIds);
      const duplicates = runIds.filter((id) => id !== canonicalId);

      if (options.keepAllToday && dateKey === todayStr) {
        console.log(`  ${dateKey}: keeping all ${runIds.length} (today), would remove ${duplicates.length} if --no-keep-all-today`);
        continue;
      }

      const reportsDir = path.join(orgPath, "org-sync-reports");
      for (const dupId of duplicates) {
        const dirPath = path.join(reportsDir, dupId);
        const relative = path.relative(reportsDir, dirPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          console.log(`  SKIP (path traversal guard): ${dupId}`);
          continue;
        }
        totalPlan.push({ org: orgName, date: dateKey, runId: dupId, path: dirPath });
      }

      const keepSummary = canonicalId
        ? `keep=${canonicalId} (${await runSummaryRepoCount(orgPath, canonicalId)} repos, ${artifactCompleteness(orgPath, canonicalId)} artifacts)`
        : "keep=?";
      const removeDesc = duplicates.length > 0 ? `remove=${duplicates.length} duplicate(s)` : "no duplicates";
      console.log(`  ${dateKey}: ${keepSummary}, ${removeDesc}`);
      for (const dupId of duplicates) {
        console.log(`    - ${dupId}`);
      }
    }
    console.log("");
  }

  if (totalPlan.length === 0) {
    console.log("No duplicates to clean up.");
    return;
  }

  console.log("---");
  console.log(`Total directories to remove: ${totalPlan.length}`);

  if (options.dryRun) {
    console.log("Dry run — no directories deleted.");
    console.log("Run with --no-dry-run to perform cleanup.");
    return;
  }

  let removedCount = 0;
  let failedCount = 0;
  for (const item of totalPlan) {
    try {
      await rm(item.path, { recursive: true, force: true });
      console.log(`DELETED: ${item.path}`);
      removedCount += 1;
    } catch (err) {
      console.error(`FAILED: ${item.path} — ${err.message}`);
      failedCount += 1;
    }
  }

  console.log(`\nCleanup complete: ${removedCount} removed, ${failedCount} failed.`);
}

main().catch((error) => {
  console.error(`org-sync-cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
