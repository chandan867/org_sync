#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SINCE = "24 hours ago";
const DEFAULT_MAX_DIFF_BYTES = 80_000;
const COMMAND_TIMEOUT_MS = 120_000;

const PRODUCT_FLOW_RULES = [
  { id: "worker-check-in", label: "Worker check-in / attendance", severity: "critical", pathPatterns: [/check.?in/i, /attendance/i, /geofence/i, /face/i, /worker/i], textPatterns: [/check.?in/i, /attendance/i, /geofence/i, /face verify/i] },
  { id: "replacement-flow", label: "Replacement / shift coverage", severity: "critical", pathPatterns: [/replacement/i, /shift/i, /schedule/i], textPatterns: [/replacement/i, /fill shift/i, /coverage/i] },
  { id: "trust-card", label: "Trust Card / public verification", severity: "critical", pathPatterns: [/trust.?card/i, /verification/i, /bgv/i, /identity/i], textPatterns: [/trust.?card/i, /verification/i, /public profile/i, /bgv/i] },
  { id: "manager-feed", label: "Manager exception feed", severity: "high", pathPatterns: [/manager/i, /home/i, /feed/i, /exception/i], textPatterns: [/exception/i, /severity/i, /manager feed/i] },
  { id: "schedule", label: "Schedule grid / shift assignment", severity: "high", pathPatterns: [/schedule/i, /shift/i, /roster/i], textPatterns: [/schedule/i, /shift/i, /roster/i] },
  { id: "tasks-patrol-incidents", label: "Tasks / patrol / incidents", severity: "medium", pathPatterns: [/task/i, /patrol/i, /incident/i], textPatterns: [/task/i, /patrol/i, /incident/i] },
  { id: "auth-invite-hierarchy", label: "Auth / invite hierarchy", severity: "high", pathPatterns: [/auth/i, /invite/i, /otp/i, /login/i], textPatterns: [/invite/i, /otp/i, /hierarchy/i, /login/i] },
];

const RISK_RULES = [
  { id: "schema-or-persistence", label: "Schema or persistence touched", severity: "high", pathPatterns: [/migration/i, /database/i, /dao/i, /room/i, /entity/i, /schema/i] },
  { id: "network-contract", label: "Network/API contract touched", severity: "high", pathPatterns: [/api/i, /dto/i, /retrofit/i, /ktor/i, /remote/i, /route/i], textPatterns: [/endpoint/i, /request/i, /response/i, /contract/i] },
  { id: "security-sensitive", label: "Security-sensitive code touched", severity: "high", pathPatterns: [/auth/i, /token/i, /session/i, /permission/i, /otp/i, /cors/i], textPatterns: [/token/i, /session/i, /permission/i, /otp/i] },
  { id: "critical-ui-flow", label: "Critical UI flow touched", severity: "medium", pathPatterns: [/screen/i, /viewmodel/i, /fragment/i, /activity/i] },
  { id: "dirty-worktree", label: "Local uncommitted work present", severity: "medium", derived: (repoSummary) => repoSummary.after?.dirty || repoSummary.before?.dirty },
];

function usage() {
  return `org-sync: pull org repos, run local Git/GitNexus analysis, and draft change reports.

Usage:
  org-sync
  org-sync --repo GuardManagementV2 --no-pull
  npm run org:sync -- --repo GuardManagementV2 --no-pull

Options:
  --org-root <path>       Folder containing multiple git repos. Default: current working directory.
  --since <value>         Git date expression for the change window. Default: "${DEFAULT_SINCE}".
  --baseline <ref>        Compare against this ref/commit instead of --since.
  --repo <name>           Include only matching repo folder name. Can be repeated.
  --output-dir <path>     Report output directory. Default: <org-root>/org-sync-reports/<timestamp>.
  --notes-dir <path>      Obsidian Markdown-only notes directory. Default: <org-root>/org-sync-notes.
  --max-diff-bytes <n>    Cap diff excerpt bytes included in prompts. Default: ${DEFAULT_MAX_DIFF_BYTES}.
  --opencode-cmd <cmd>    OpenCode command. Default: "opencode run".
  --gitnexus-cmd <cmd>    GitNexus fallback command. Default: "npx gitnexus".
  --no-pull               Skip git fetch/pull.
  --allow-dirty-pull      Allow pull even when a repo has uncommitted local changes.
  --gitnexus-analyze      Run GitNexus analyze before status. May update GitNexus-generated files.
  --no-gitnexus           Skip GitNexus commands entirely.
  --llm                   Invoke OpenCode for report synthesis. Enabled by default.
  --no-llm                Disable OpenCode and write local-only deterministic report/prompts.
  --deep                  Write deep-review-prompt.md with product-flow and risk-focused review instructions.
  --release               Write release-review-prompt.md with release gates and ship/demo readiness prompts.
  --no-notes              Do not write Obsidian Markdown notes.
  --dry-run               Print planned actions without pulling, analyzing, invoking LLM, or writing reports.
  --help                  Show this help.

Notes:
  - Git is the truth source. GitNexus is best-effort structural analysis. OpenCode is reasoning only.
  - Prompt/report artifacts can contain code, diffs, paths, and sensitive context. Review before sharing or committing.
  - OpenCode may send prompt content according to your configured provider. Use --no-llm for local-only output.
`;
}

function parseArgs(argv) {
  const options = {
    orgRoot: process.cwd(),
    since: DEFAULT_SINCE,
    baseline: null,
    repos: [],
    outputDir: null,
    notesDir: null,
    maxDiffBytes: DEFAULT_MAX_DIFF_BYTES,
    opencodeCmd: "opencode run",
    gitnexusCmd: "npx gitnexus",
    pull: true,
    allowDirtyPull: false,
    gitnexus: true,
    gitnexusAnalyze: false,
    llm: true,
    deep: false,
    release: false,
    notes: true,
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

    switch (arg) {
      case "--org-root":
        options.orgRoot = path.resolve(next());
        break;
      case "--since":
        options.since = next();
        break;
      case "--baseline":
        options.baseline = next();
        break;
      case "--repo":
        options.repos.push(next());
        break;
      case "--output-dir":
        options.outputDir = path.resolve(next());
        break;
      case "--notes-dir":
        options.notesDir = path.resolve(next());
        break;
      case "--max-diff-bytes": {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--max-diff-bytes must be a non-negative integer");
        options.maxDiffBytes = parsed;
        break;
      }
      case "--opencode-cmd":
        options.opencodeCmd = next();
        break;
      case "--gitnexus-cmd":
        options.gitnexusCmd = next();
        break;
      case "--no-pull":
        options.pull = false;
        break;
      case "--allow-dirty-pull":
        options.allowDirtyPull = true;
        break;
      case "--gitnexus-analyze":
        options.gitnexusAnalyze = true;
        break;
      case "--no-gitnexus":
        options.gitnexus = false;
        break;
      case "--llm":
        options.llm = true;
        break;
      case "--deep":
        options.deep = true;
        break;
      case "--release":
        options.release = true;
        break;
      case "--no-llm":
        options.llm = false;
        break;
      case "--no-notes":
        options.notes = false;
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

  if (!options.outputDir) {
    options.outputDir = path.join(options.orgRoot, "org-sync-reports", timestampForPath(new Date()));
  }
  if (!options.notesDir) {
    options.notesDir = path.join(options.orgRoot, "org-sync-notes");
  }

  return options;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function datePartsForNotes(date) {
  const yyyyMmDd = date.toISOString().slice(0, 10);
  const [year, month] = yyyyMmDd.split("-");
  return { yyyyMmDd, year, month };
}

function sanitizeRepoFileName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "unknown-repo";
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function noteLink(filePathWithoutMd, label = null) {
  return label ? `[[${filePathWithoutMd}|${label}]]` : `[[${filePathWithoutMd}]]`;
}

function shellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  for (const char of command.trim()) {
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (/\s/.test(char) && quote === null) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function truncate(text, maxBytes) {
  const buffer = Buffer.from(text ?? "", "utf8");
  if (buffer.length <= maxBytes) return { text: text ?? "", truncated: false, originalBytes: buffer.length };
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8") + `\n\n[truncated: ${buffer.length - maxBytes} bytes omitted]\n`,
    truncated: true,
    originalBytes: buffer.length,
  };
}

function commandText(cmd, args) {
  return [cmd, ...args].join(" ");
}

function run(cmd, args = [], { cwd = process.cwd(), timeoutMs = COMMAND_TIMEOUT_MS, allowFailure = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const result = { ok: false, code: null, stdout, stderr, error: error.message, command: commandText(cmd, args) };
      if (allowFailure) resolve(result);
      else reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const timedOut = signal === "SIGTERM";
      const result = {
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        error: timedOut ? `Timed out after ${timeoutMs}ms` : null,
        command: commandText(cmd, args),
      };
      if (!result.ok && !allowFailure) reject(new Error(`${result.command} failed: ${result.stderr || result.error}`));
      else resolve(result);
    });
  });
}

async function discoverRepos(orgRoot, filters) {
  const entries = await readdir(orgRoot, { withFileTypes: true });
  const filterSet = new Set(filters);
  const repos = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "org-sync-reports") continue;
    if (filterSet.size > 0 && !filterSet.has(entry.name)) continue;

    const repoPath = path.join(orgRoot, entry.name);
    const gitPath = path.join(repoPath, ".git");
    if (!existsSync(gitPath)) continue;
    repos.push({ name: entry.name, path: repoPath });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

async function git(cwd, args, options = {}) {
  return run("git", args, { cwd, ...options });
}

async function gitText(cwd, args) {
  const result = await git(cwd, args);
  return result.ok ? result.stdout.trim() : "";
}

async function ensureGit() {
  const result = await run("git", ["--version"]);
  if (!result.ok) throw new Error("git is required but was not found on PATH");
}

async function collectGitMetadata(repo) {
  const [branch, head, remote, status] = await Promise.all([
    gitText(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitText(repo.path, ["rev-parse", "HEAD"]),
    gitText(repo.path, ["config", "--get", "remote.origin.url"]),
    gitText(repo.path, ["status", "--porcelain"]),
  ]);
  return { branch, head, remote, dirty: status.length > 0, status };
}

async function collectUncommittedSummary(repo, options) {
  const [cachedStat, cachedNameStatus, cachedDiff, worktreeStat, worktreeNameStatus, worktreeDiff, untracked] = await Promise.all([
    git(repo.path, ["diff", "--cached", "--stat"]),
    git(repo.path, ["diff", "--cached", "--name-status"]),
    git(repo.path, ["diff", "--cached"], { timeoutMs: 180_000 }),
    git(repo.path, ["diff", "--stat"]),
    git(repo.path, ["diff", "--name-status"]),
    git(repo.path, ["diff"], { timeoutMs: 180_000 }),
    git(repo.path, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const cachedExcerpt = truncate(cachedDiff.stdout, Math.floor(options.maxDiffBytes / 2));
  const worktreeExcerpt = truncate(worktreeDiff.stdout, Math.floor(options.maxDiffBytes / 2));
  return {
    cachedStat: cachedStat.stdout.trim(),
    cachedNameStatus: cachedNameStatus.stdout.trim(),
    cachedDiffExcerpt: cachedExcerpt.text,
    cachedDiffTruncated: cachedExcerpt.truncated,
    worktreeStat: worktreeStat.stdout.trim(),
    worktreeNameStatus: worktreeNameStatus.stdout.trim(),
    worktreeDiffExcerpt: worktreeExcerpt.text,
    worktreeDiffTruncated: worktreeExcerpt.truncated,
    untrackedFiles: untracked.stdout.trim(),
    errors: [cachedStat, cachedNameStatus, cachedDiff, worktreeStat, worktreeNameStatus, worktreeDiff, untracked]
      .filter((result) => !result.ok)
      .map((result) => ({ command: result.command, error: result.stderr.trim() || result.error })),
  };
}

async function pullRepo(repo, options) {
  if (!options.pull) return [{ skipped: true, reason: "--no-pull" }];
  if (!options.allowDirtyPull) {
    const status = await gitText(repo.path, ["status", "--porcelain"]);
    if (status.length > 0) {
      return [{ skipped: true, reason: "working tree dirty; use --allow-dirty-pull to pull anyway" }];
    }
  }
  return [
    await git(repo.path, ["fetch", "--all", "--prune"], { timeoutMs: 180_000 }),
    await git(repo.path, ["pull", "--ff-only"], { timeoutMs: 180_000 }),
  ];
}

async function emptyTreeHash(repo) {
  const result = await git(repo.path, ["hash-object", "-t", "tree", "/dev/null"]);
  return result.ok && result.stdout.trim()
    ? result.stdout.trim()
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

async function resolveBase(repo, options) {
  if (options.baseline) {
    const result = await git(repo.path, ["rev-parse", "--verify", options.baseline]);
    return {
      mode: "baseline",
      ref: options.baseline,
      base: result.ok ? result.stdout.trim() : null,
      error: result.ok ? null : result.stderr.trim() || result.error,
    };
  }

  const before = await git(repo.path, ["rev-list", "-1", `--before=${options.since}`, "HEAD"]);
  if (before.ok && before.stdout.trim()) {
    return { mode: "since", ref: options.since, base: before.stdout.trim(), error: null };
  }

  const root = await git(repo.path, ["rev-list", "--max-parents=0", "HEAD"]);
  const emptyTree = await emptyTreeHash(repo);
  return {
    mode: "since",
    ref: options.since,
    base: root.ok ? emptyTree : null,
    baseIsEmptyTree: root.ok,
    error: root.ok ? "No commit before since window; comparing against the empty tree." : root.stderr.trim() || root.error,
  };
}

async function collectGitSummary(repo, baseInfo, options) {
  const range = baseInfo.base ? `${baseInfo.base}..HEAD` : "HEAD";
  const logArgs = baseInfo.base && !baseInfo.baseIsEmptyTree
    ? ["log", "--oneline", "--decorate", range]
    : ["log", "--since", options.since, "--oneline", "--decorate"];
  const authorLogArgs = baseInfo.base && !baseInfo.baseIsEmptyTree
    ? ["log", "--format=%H%x09%an%x09%ae%x09%s", range]
    : ["log", "--since", options.since, "--format=%H%x09%an%x09%ae%x09%s"];
  const [stat, shortstat, nameStatus, log, authorLog, diff] = await Promise.all([
    git(repo.path, ["diff", "--stat", range]),
    git(repo.path, ["diff", "--shortstat", range]),
    git(repo.path, ["diff", "--name-status", range]),
    git(repo.path, logArgs),
    git(repo.path, authorLogArgs),
    git(repo.path, ["diff", "--find-renames", range], { timeoutMs: 180_000 }),
  ]);
  const diffExcerpt = truncate(diff.stdout, options.maxDiffBytes);
  const developers = parseDeveloperSummary(authorLog.stdout);
  return {
    range,
    stat: stat.stdout.trim(),
    shortstat: shortstat.stdout.trim(),
    nameStatus: nameStatus.stdout.trim(),
    log: log.stdout.trim(),
    developerSummary: developers.markdown,
    developers: developers.data,
    diffExcerpt: diffExcerpt.text,
    diffTruncated: diffExcerpt.truncated,
    diffOriginalBytes: diffExcerpt.originalBytes,
    errors: [stat, shortstat, nameStatus, log, authorLog, diff]
      .filter((result) => !result.ok)
      .map((result) => ({ command: result.command, error: result.stderr.trim() || result.error })),
  };
}

function parseDeveloperSummary(authorLog) {
  const byAuthor = new Map();
  for (const line of authorLog.trim().split("\n").filter(Boolean)) {
    const [hash, name, email, ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t");
    const key = `${name || "Unknown"} <${email || "unknown"}>`;
    if (!byAuthor.has(key)) byAuthor.set(key, { name: name || "Unknown", email: email || "unknown", commits: [] });
    byAuthor.get(key).commits.push({ hash: hash?.slice(0, 7) || "unknown", subject: subject || "No subject" });
  }
  const data = Array.from(byAuthor.values()).sort((a, b) => b.commits.length - a.commits.length || a.name.localeCompare(b.name));
  const markdown = data.length
    ? data.map((author) => `- ${author.name} <${author.email}> — ${author.commits.length} commit(s)\n${author.commits.map((commit) => `  - ${commit.hash} ${commit.subject}`).join("\n")}`).join("\n")
    : "No committed changes by developer in this window.";
  return { data, markdown };
}

async function runGitNexus(repo, options) {
  if (!options.gitnexus) return [{ skipped: true, label: "gitnexus", reason: "--no-gitnexus" }];

  const localRunner = path.join(repo.path, ".gitnexus", "run.cjs");
  const commands = [];

  if (existsSync(localRunner)) {
    if (options.gitnexusAnalyze) commands.push({ label: "analyze", cmd: "node", args: [localRunner, "analyze"] });
    commands.push({ label: "status", cmd: "node", args: [localRunner, "status"] });
  } else {
    const parts = shellWords(options.gitnexusCmd);
    if (parts.length === 0) return [{ label: "gitnexus", ok: false, command: "", stdout: "", stderr: "Empty --gitnexus-cmd", error: "Empty --gitnexus-cmd" }];
    const cmd = parts[0];
    const prefix = parts.slice(1);
    if (options.gitnexusAnalyze) commands.push({ label: "analyze", cmd, args: [...prefix, "analyze"] });
    commands.push({ label: "status", cmd, args: [...prefix, "status"] });
  }

  const results = [];
  for (const item of commands) {
    const result = await run(item.cmd, item.args, { cwd: repo.path, timeoutMs: 300_000 });
    results.push({
      label: item.label,
      command: result.command,
      ok: result.ok,
      stdout: truncate(result.stdout, 20_000).text,
      stderr: truncate(result.stderr, 10_000).text,
      error: result.error,
    });
  }
  return results;
}

function hasMeaningfulChanges(summary) {
  return Boolean(
    summary.git.log ||
      summary.git.nameStatus ||
      summary.git.shortstat ||
      summary.uncommitted?.cachedNameStatus ||
      summary.uncommitted?.worktreeNameStatus ||
      summary.uncommitted?.untrackedFiles,
  );
}

function parseChangedFileLines(nameStatusText) {
  return (nameStatusText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts[0]?.startsWith("R") && parts.length >= 3) return { status: parts[0], path: parts[2], previousPath: parts[1] };
      return { status: parts[0] || "?", path: parts.slice(1).join(" ") || line };
    });
}

function repoChangedFiles(repoSummary) {
  const files = [
    ...parseChangedFileLines(repoSummary.git?.nameStatus),
    ...parseChangedFileLines(repoSummary.uncommitted?.cachedNameStatus),
    ...parseChangedFileLines(repoSummary.uncommitted?.worktreeNameStatus),
  ];
  const seen = new Set();
  return files.filter((file) => {
    const key = `${file.status}:${file.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repoEvidenceText(repoSummary) {
  return [
    repoSummary.git?.log,
    repoSummary.git?.developerSummary,
    repoSummary.git?.diffExcerpt,
    repoSummary.uncommitted?.cachedDiffExcerpt,
    repoSummary.uncommitted?.worktreeDiffExcerpt,
  ].filter(Boolean).join("\n");
}

function matchRules(rules, repoSummary) {
  const changedFiles = repoChangedFiles(repoSummary);
  const evidenceText = repoEvidenceText(repoSummary);
  const allowTextEvidence = changedFiles.some((file) => /(^|\/)(app|src|server|client|lib|data|domain|ui|presentation)(\/|$)|\.(kt|java|js|ts|tsx|jsx|py|go|swift|xml|gradle|sql)$/i.test(file.path));
  return rules.map((rule) => {
    const evidence = [];
    for (const file of changedFiles) {
      if (rule.pathPatterns?.some((pattern) => pattern.test(file.path))) evidence.push(`path: ${file.path}`);
      if (file.previousPath && rule.pathPatterns?.some((pattern) => pattern.test(file.previousPath))) evidence.push(`path: ${file.previousPath}`);
    }
    if (allowTextEvidence && rule.textPatterns?.some((pattern) => pattern.test(evidenceText))) evidence.push("text: keyword matched in commits/diff excerpt");
    if (rule.derived?.(repoSummary)) evidence.push("state: derived repo condition matched");
    return evidence.length ? { id: rule.id, label: rule.label, severity: rule.severity, evidence: Array.from(new Set(evidence)).slice(0, 6) } : null;
  }).filter(Boolean);
}

function tagProductFlows(repoSummary) {
  return matchRules(PRODUCT_FLOW_RULES, repoSummary);
}

function tagRisks(repoSummary) {
  return matchRules(RISK_RULES, repoSummary);
}

function reviewRecommendation(productFlows, riskTags) {
  const reasons = [];
  for (const flow of productFlows) {
    if (flow.severity === "critical") reasons.push(`Critical product flow touched: ${flow.label}`);
  }
  for (const risk of riskTags) {
    if (risk.severity === "high") reasons.push(`High-risk area touched: ${risk.label}`);
  }
  return {
    deepRecommended: reasons.length > 0,
    releaseRecommended: reasons.length > 0,
    reasons,
  };
}

function commitsFromLog(logText) {
  return (logText || "").split("\n").filter(Boolean).map((line) => {
    const [hash, ...subjectParts] = line.trim().split(/\s+/);
    return { hash, subject: subjectParts.join(" ") };
  });
}

function buildFounderSignals(runSummary, reportPath) {
  const repos = runSummary.repos.map((repo) => ({
    name: repo.name,
    path: repo.path,
    branch: repo.after?.branch || repo.before?.branch || "unknown",
    head: repo.after?.head || "unknown",
    changedFiles: repoChangedFiles(repo),
    commits: commitsFromLog(repo.git?.log),
    productFlows: repo.productFlows || [],
    riskTags: repo.riskTags || [],
    review: repo.review || { deepRecommended: false, releaseRecommended: false, reasons: [] },
  }));
  return {
    schemaVersion: 1,
    generatedAt: runSummary.generatedAt,
    orgRoot: runSummary.options.orgRoot,
    reportPath,
    deepReviewPromptPath: runSummary.deepReviewPromptPath || null,
    releaseReviewPromptPath: runSummary.releaseReviewPromptPath || null,
    window: { since: runSummary.options.since, baseline: runSummary.options.baseline || null },
    summary: {
      reposAnalyzed: runSummary.repos.length,
      reposWithChanges: runSummary.repos.filter(hasMeaningfulChanges).length,
      criticalFlowHits: repos.reduce((count, repo) => count + repo.productFlows.filter((flow) => flow.severity === "critical").length, 0),
      highRiskRepos: repos.filter((repo) => repo.riskTags.some((risk) => risk.severity === "high")).length,
      deepReviewRecommended: repos.some((repo) => repo.review.deepRecommended),
      releaseReviewRecommended: repos.some((repo) => repo.review.releaseRecommended),
    },
    repos,
  };
}

function formatTags(tags) {
  return tags?.length ? tags.map((tag) => `- ${tag.label} (${tag.severity}) — ${tag.evidence.join("; ")}`).join("\n") : "- None detected.";
}

function aggregateDevelopers(repos) {
  const byKey = new Map();
  for (const repo of repos) {
    const devs = (repo.git?.developers || []);
    const productFlows = repo.productFlows || [];
    const riskTags = repo.riskTags || [];
    for (const dev of devs) {
      const key = `${dev.name} <${dev.email}>`;
      if (!byKey.has(key)) {
        byKey.set(key, { name: dev.name, email: dev.email, commits: 0, repos: [], commitSubjects: [], productFlows: [], riskTags: [] });
      }
      const record = byKey.get(key);
      record.commits += (dev.commits || []).length;
      if (!record.repos.includes(repo.name)) record.repos.push(repo.name);
      for (const c of (dev.commits || [])) {
        if (c.subject && !record.commitSubjects.includes(c.subject)) record.commitSubjects.push(c.subject);
      }
      for (const flow of productFlows) {
        if (!record.productFlows.some((f) => f.id === flow.id)) record.productFlows.push(flow);
      }
      for (const risk of riskTags) {
        if (!record.riskTags.some((r) => r.id === risk.id)) record.riskTags.push(risk);
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

function buildAgencyBriefs(runSummary, founderSignals, outputDir) {
  const briefsDir = path.join(outputDir, "agency-briefs");
  const devs = aggregateDevelopers(runSummary.repos);

  function briefContext(domain, questions) {
    const changedRepos = founderSignals.repos.filter((r) => (r.commits || []).length > 0 || (r.changedFiles || []).length > 0);
    const repoTable = changedRepos.map((r) => {
      const flows = (r.productFlows || []).map((f) => f.label).join(", ") || "none";
      const risks = (r.riskTags || []).map((t) => t.label).join(", ") || "none";
      const commits = (r.commits || []).length;
      return "- **" + r.name + "** (" + commits + " commits): flows=[" + flows + "], risks=[" + risks + "]";
    }).join("\n") || "No committed changes in this window.";
    const devTableLines = devs.map(function (d) {
      return "- **" + d.name + "** <" + d.email + ">: " + d.commits + " commits across [" + d.repos.join(", ") + "]";
    }).join("\n") || "No developer data.";

    const allFlows = founderSignals.repos.flatMap(function (r) { return r.productFlows || []; });
    const uniqueFlows = [...new Map(allFlows.map(function (f) { return [f.id, f]; })).values()];

    var flowLines = uniqueFlows.length
      ? uniqueFlows.map(function (f) { return "- " + f.label + " (" + f.severity + ")"; }).join("\n")
      : "- None detected.";
    var riskLines = founderSignals.repos.flatMap(function (r) {
      return (r.riskTags || []).map(function (t) {
        return "- " + t.label + " (" + t.severity + ") - repo: " + r.name;
      });
    }).join("\n") || "- None detected.";
    var baseStr = founderSignals.window.baseline ? " (baseline: " + founderSignals.window.baseline + ")" : "";

    return "\n## Run Context\n\n"
      + "- Org root: " + founderSignals.orgRoot + "\n"
      + "- Date: " + founderSignals.generatedAt.slice(0, 10) + "\n"
      + "- Window: " + founderSignals.window.since + baseStr + "\n"
      + "- Report: " + founderSignals.reportPath + "\n"
      + "- Domain: " + domain + "\n\n"
      + "## Changed Repositories\n\n" + repoTable + "\n\n"
      + "## Product Flows Touched\n\n" + flowLines + "\n\n"
      + "## Risk Tags\n\n" + riskLines + "\n\n"
      + "## Developer-Wise Changes\n\n" + devTableLines + "\n\n"
      + "## Domain-Specific Questions\n\n" + questions + "\n\n"
      + "## Guardrails\n\n"
      + "- Base analysis **only** on the evidence above. Do not infer behavior from file paths or commit messages alone.\n"
      + "- Flag uncertainties explicitly as not enough evidence.\n"
      + "- Do not speculate on business impact, revenue, or customer sentiment unless explicitly stated in evidence.\n"
      + "- Do not generate code, patches, or implementation plans unless asked.\n"
      + "- If critical information is missing, state what is needed rather than filling gaps with assumptions.\n";
  }

  var productQuestions = "- Which product flows were touched and how do they affect the user journey?\n"
    + "- Are there any breaking changes or behavioral shifts for existing users?\n"
    + "- What feature areas need QA attention based on changed files?\n"
    + "- Which product metrics (engagement, retention, conversion) could be impacted by these changes?\n"
    + "- Is there enough test coverage for the changed flows?\n"
    + "- What dependencies or integration points should be verified before the next release?";
  var gtmQuestions = "- Which product changes create new sales stories or demo talking points?\n"
    + "- Are any changes risky to demonstrate or sell before further validation?\n"
    + "- Do these changes unblock new customer segments or use cases?\n"
    + "- What product narratives became stronger or weaker based on engineering evidence?\n"
    + "- Are there any competitive positioning implications?\n"
    + "- Should pricing, packaging, or messaging be adjusted based on these changes?";
  var salesQuestions = "- Which changes are demo-ready and which are not?\n"
    + "- What objections could these changes address or introduce?\n"
    + "- Are there new integrations, APIs, or capabilities available for prospects?\n"
    + "- Should any existing pipeline deals be updated based on product changes?\n"
    + "- What competitive advantages or gaps do these changes create?\n"
    + "- Are there compliance, security, or reliability changes that affect enterprise sales?";
  var marketingQuestions = "- What content angles (blog posts, LinkedIn, case studies) do these changes support?\n"
    + "- Which product narratives gained evidence or became stronger?\n"
    + "- What proof points are now available (performance, security, scale)?\n"
    + "- Are there any customer-facing announcements warranted?\n"
    + "- Should the website, docs, or demos be updated based on these changes?\n"
    + "- What social proof or community content could be generated from recent progress?";
  var engineeringQuestions = "- What is the technical risk profile of these changes?\n"
    + "- Are there database schema changes, API contract changes, or security implications?\n"
    + "- Which repos need code review, additional tests, or manual QA?\n"
    + "- Are there architectural or dependency concerns across repos?\n"
    + "- What monitoring, logging, or observability changes are needed?\n"
    + "- Should a release be gated on any specific fix or validation?";
  var csQuestions = "- Are there any changes that affect how customers use the product day-to-day?\n"
    + "- Which changes might require customer communication, docs updates, or onboarding changes?\n"
    + "- Are there known issues, regressions, or feature gaps in the changed areas?\n"
    + "- Should customer support be briefed on any behavioral or UI changes?\n"
    + "- What customer-facing metrics (uptime, response times, error rates) may be affected?\n"
    + "- Are there migration steps, breaking changes, or deprecations customers should know about?";

  var productExtra = founderSignals.repos.map(function (r) {
    var files = (r.changedFiles || []).length
      ? r.changedFiles.map(function (f) { return "- " + f.status + " " + f.path; }).join("\n")
      : "- No changed files.";
    return "### " + r.name + "\n" + files;
  }).join("\n\n");

  var devDetails = devs.map(function (d) {
    var subjects = d.commitSubjects.length ? d.commitSubjects.map(function (s) { return "  - " + s; }).join("\n") : "";
    var flows = d.productFlows.map(function (f) { return f.label + " (" + f.severity + ")"; }).join(", ") || "none";
    var risks = d.riskTags.map(function (t) { return t.label + " (" + t.severity + ")"; }).join(", ") || "none";
    return "### " + d.name + " <" + d.email + ">\n\n"
      + "- Commits: " + d.commits + "\n"
      + "- Repos: " + d.repos.join(", ") + "\n"
      + "- Subjects:\n" + subjects + "\n"
      + "- Related product flows: " + flows + "\n"
      + "- Related risk tags: " + risks + "\n";
  }).join("\n") || "No developer data found.";

  var productMd = "# Agency Brief: Product\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for product strategy reasoning.\n\n"
    + briefContext("Product", productQuestions) + "\n\n"
    + "## Changed File Summary by Repo\n\n"
    + productExtra + "\n";

  var gtmMd = "# Agency Brief: GTM\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for GTM/strategy reasoning.\n\n"
    + briefContext("GTM", gtmQuestions) + "\n";

  var salesMd = "# Agency Brief: Sales\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for sales reasoning.\n\n"
    + briefContext("Sales", salesQuestions) + "\n";

  var marketingMd = "# Agency Brief: Marketing\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for marketing/content reasoning.\n\n"
    + briefContext("Marketing", marketingQuestions) + "\n";

  var engineeringMd = "# Agency Brief: Engineering\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for engineering/technical reasoning.\n\n"
    + briefContext("Engineering", engineeringQuestions) + "\n\n"
    + "## Developer Details\n\n"
    + devDetails + "\n";

  var csMd = "# Agency Brief: Customer Success\n\n"
    + "This brief is generated by `org-sync` in deterministic mode (no LLM invoked). It provides structured evidence for customer success/support reasoning.\n\n"
    + briefContext("Customer Success", csQuestions) + "\n";

  const briefs = {
    "product.md": productMd,
    "gtm.md": gtmMd,
    "sales.md": salesMd,
    "marketing.md": marketingMd,
    "engineering.md": engineeringMd,
    "customer-success.md": csMd,
  };

  return { briefsDir, briefs };
}

function buildAgencyBriefIndex(briefIds) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    briefs: [
      { id: "product", label: "Product", file: "product.md", description: "Product strategy evidence and feature flow analysis" },
      { id: "gtm", label: "GTM", file: "gtm.md", description: "Go-to-market strategy evidence" },
      { id: "sales", label: "Sales", file: "sales.md", description: "Sales enablement and deal intelligence" },
      { id: "marketing", label: "Marketing", file: "marketing.md", description: "Marketing and content strategy evidence" },
      { id: "engineering", label: "Engineering", file: "engineering.md", description: "Technical risk, architecture, and code quality review" },
      { id: "customer-success", label: "Customer Success", file: "customer-success.md", description: "Customer impact, support, and onboarding changes" },
    ],
  };
}

function buildDeepReviewPrompt(runSummary, founderSignals) {
  const repoSections = runSummary.repos
    .filter((repo) => repo.review?.deepRecommended || hasMeaningfulChanges(repo))
    .map((repo) => `## ${repo.name}\n\nDeep recommended: ${repo.review?.deepRecommended ? "yes" : "no"}\nReasons:\n${repo.review?.reasons?.map((reason) => `- ${reason}`).join("\n") || "- None."}\n\nProduct flows:\n${formatTags(repo.productFlows)}\n\nRisk tags:\n${formatTags(repo.riskTags)}\n\nChanged files:\n${repoChangedFiles(repo).map((file) => `- ${file.status} ${file.path}`).join("\n") || "- None."}\n\nCommits:\n${repo.git?.log || "No commits."}\n\nDiff excerpt:\n\`\`\`diff\n${repo.git?.diffExcerpt || "No diff excerpt."}\n\`\`\``)
    .join("\n\n---\n\n");
  return `# Deep Technical Review Prompt\n\nThis prompt was generated by org-sync. MCP/GitNexus impact tools were not run by the script. Verify against source before making claims.\n\n## Run Context\n\n- Org root: ${runSummary.options.orgRoot}\n- Since: ${runSummary.options.since}\n- Baseline: ${runSummary.options.baseline || "none"}\n- Deep review recommended: ${founderSignals.summary.deepReviewRecommended ? "yes" : "no"}\n\n## Required Review\n\n1. Inspect high-risk repos first.\n2. Identify likely affected product flows.\n3. Check API/schema/auth/shared-contract risks.\n4. Recommend tests/manual QA.\n5. Call out unknowns and where MCP impact analysis should be run manually.\n\n${repoSections || "No repositories with meaningful changes."}\n`;
}

function buildReleaseReviewPrompt(runSummary, founderSignals) {
  return `# Release Readiness Review Prompt\n\nThis prompt was generated by org-sync. Use it to decide whether today’s changes are demo-ready or ship-ready.\n\n## Summary\n\n- Repos analyzed: ${founderSignals.summary.reposAnalyzed}\n- Repos with changes: ${founderSignals.summary.reposWithChanges}\n- Critical flow hits: ${founderSignals.summary.criticalFlowHits}\n- High-risk repos: ${founderSignals.summary.highRiskRepos}\n\n## Required Output\n\nFor each changed repo, answer:\n\n1. Can demo? yes/no/with caveats.\n2. Can ship? yes/no/blocked.\n3. Required tests.\n4. Manual QA gates.\n5. Rollback/data risk.\n6. Blockers before release.\n\n## Repos\n\n${founderSignals.repos.map((repo) => `### ${repo.name}\n\nReview reasons:\n${repo.review.reasons.map((reason) => `- ${reason}`).join("\n") || "- None."}\n\nProduct flows:\n${formatTags(repo.productFlows)}\n\nRisk tags:\n${formatTags(repo.riskTags)}\n\nChanged files:\n${repo.changedFiles.map((file) => `- ${file.status} ${file.path}`).join("\n") || "- None."}`).join("\n\n")}\n`;
}

function buildRepoPrompt(repoSummary) {
  return `# Repo Change Understanding Task

You are analyzing changes after a local org sync. Git is the truth source. GitNexus output is structural context. Reason about behavior only where the evidence supports it; call out unknowns.

## Repo
- Name: ${repoSummary.name}
- Path: ${repoSummary.path}
- Branch before pull: ${repoSummary.before.branch || "unknown"}
- HEAD before pull: ${repoSummary.before.head || "unknown"}
- Branch after pull: ${repoSummary.after.branch || "unknown"}
- HEAD after pull: ${repoSummary.after.head || "unknown"}
- Remote: ${repoSummary.after.remote || repoSummary.before.remote || "unknown"}
- Comparison: ${repoSummary.base.mode} ${repoSummary.base.ref}
- Base commit: ${repoSummary.base.base || "unresolved"}
- Dirty before sync: ${repoSummary.before.dirty ? "yes" : "no"}
- Dirty after sync: ${repoSummary.after.dirty ? "yes" : "no"}

## Pull Results
${formatCommandResults(repoSummary.pullResults)}

## Git Summary
### Commits
${repoSummary.git.log || "No commits found in this window."}

### Developer-wise Changes
${repoSummary.git.developerSummary || "No developer summary."}

### Diff Stat
${repoSummary.git.stat || "No diff stat."}

### Changed Files
${repoSummary.git.nameStatus || "No changed files."}

### Short Stat
${repoSummary.git.shortstat || "No shortstat."}

## Local Uncommitted Changes
### Staged
${repoSummary.uncommitted.cachedNameStatus || repoSummary.uncommitted.cachedStat || "No staged changes."}

### Unstaged
${repoSummary.uncommitted.worktreeNameStatus || repoSummary.uncommitted.worktreeStat || "No unstaged changes."}

### Untracked
${repoSummary.uncommitted.untrackedFiles || "No untracked files."}

## GitNexus Best-Effort Analysis
Standalone scripts cannot call MCP tools directly, so this section contains local GitNexus CLI analyze/status output where available.

${formatGitNexusResults(repoSummary.gitnexus)}

## Diff Excerpt
${repoSummary.git.diffExcerpt || "No diff excerpt."}

## Uncommitted Diff Excerpt
### Staged
${repoSummary.uncommitted.cachedDiffExcerpt || "No staged diff."}

### Unstaged
${repoSummary.uncommitted.worktreeDiffExcerpt || "No unstaged diff."}

### Untracked
${repoSummary.uncommitted.untrackedFiles || "No untracked files."}

## Task
Write a concise before/after change explanation for this repo:

1. Key changes grouped by behavior/flow.
2. Developer-wise summary: who changed what, based only on commit authors and messages.
3. What the system likely did before.
4. What it likely does now.
5. User/business behavior changes.
6. Impacted flows or modules.
7. Risk level: LOW / MEDIUM / HIGH, with reasoning.
8. Edge cases and testing/manual checks recommended.
9. Unknowns where evidence is insufficient.
`;
}

function formatCommandResults(results) {
  if (!results?.length) return "No commands run.";
  return results
    .map((result) => {
      if (result.skipped) return `- Skipped: ${result.reason}`;
      return `- ${result.command}: ${result.ok ? "ok" : "failed"}${result.stderr ? `\n  stderr: ${truncate(result.stderr.trim(), 2_000).text}` : ""}`;
    })
    .join("\n");
}

function formatGitNexusResults(results) {
  if (!results?.length) return "GitNexus was not run.";
  return results
    .map((result) => {
      if (result.skipped) return `### ${result.label}: skipped\n${result.reason}`;
      return `### ${result.label}: ${result.ok ? "ok" : "failed"}\nCommand: \`${result.command}\`\n\nSTDOUT:\n\`\`\`\n${result.stdout || ""}\n\`\`\`\n\nSTDERR:\n\`\`\`\n${result.stderr || result.error || ""}\n\`\`\``;
    })
    .join("\n\n");
}

function buildDeterministicRepoReport(repoSummary) {
  const risk = repoSummary.after.dirty || repoSummary.git.errors.length || repoSummary.gitnexus.some((result) => !result.skipped && !result.ok)
    ? "MEDIUM"
    : hasMeaningfulChanges(repoSummary)
      ? "LOW"
      : "LOW";

  return `## ${repoSummary.name}

### Key Changes
${repoSummary.git.log ? repoSummary.git.log.split("\n").map((line) => `- ${line}`).join("\n") : "- No commits found in the selected window."}

### Developer-wise Changes
${repoSummary.git.developerSummary || "No committed changes by developer in this window."}

### Changed Files
${repoSummary.git.nameStatus ? repoSummary.git.nameStatus.split("\n").map((line) => `- ${line}`).join("\n") : "- No changed files found."}

### Local Uncommitted Changes
${repoSummary.uncommitted.cachedNameStatus ? `Staged:\n${repoSummary.uncommitted.cachedNameStatus.split("\n").map((line) => `- ${line}`).join("\n")}` : "Staged: none."}

${repoSummary.uncommitted.worktreeNameStatus ? `Unstaged:\n${repoSummary.uncommitted.worktreeNameStatus.split("\n").map((line) => `- ${line}`).join("\n")}` : "Unstaged: none."}

${repoSummary.uncommitted.untrackedFiles ? `Untracked:\n${repoSummary.uncommitted.untrackedFiles.split("\n").map((line) => `- ${line}`).join("\n")}` : "Untracked: none."}

### GitNexus Impact Analysis
- GitNexus CLI status: ${repoSummary.gitnexus.length ? repoSummary.gitnexus.map((result) => `${result.label}=${result.skipped ? "skipped" : result.ok ? "ok" : "failed"}`).join(", ") : "not run"}
- Note: direct MCP \`detect_changes\`/\`impact\` calls are not available from this standalone Node script. Use the generated prompt for LLM/MCP-assisted before/after reasoning if needed.

### Product-Critical Flows
${formatTags(repoSummary.productFlows)}

### Risk Tags
${formatTags(repoSummary.riskTags)}

### Review Recommendation
- Deep review recommended: ${repoSummary.review?.deepRecommended ? "yes" : "no"}
${repoSummary.review?.reasons?.length ? repoSummary.review.reasons.map((reason) => `- ${reason}`).join("\n") : "- No deep review trigger detected."}

### Before vs After Behavior
${hasMeaningfulChanges(repoSummary) ? "Prompt generated for OpenCode/manual reasoning. Deterministic mode does not infer behavior from raw diff beyond the Git summary." : "No meaningful change detected in the selected window."}

### Risk
- ${risk}

### Warnings
${repoSummary.warnings.length ? repoSummary.warnings.map((warning) => `- ${warning}`).join("\n") : "- None."}
`;
}

function buildOrgPrompt(runSummary) {
  const repoSections = runSummary.repos
    .map((repo) => `## ${repo.name}\n\n### Commit Log\n${repo.git.log || "No commits."}\n\n### Developer-wise Changes\n${repo.git.developerSummary || "No developer summary."}\n\n### Changed Files\n${repo.git.nameStatus || "No changed files."}\n\n### Product-Critical Flows\n${formatTags(repo.productFlows)}\n\n### Risk Tags\n${formatTags(repo.riskTags)}\n\n### Deep Review Recommendation\n${repo.review?.deepRecommended ? repo.review.reasons.map((reason) => `- ${reason}`).join("\n") : "- No deep review trigger detected."}\n\n### Short Stat\n${repo.git.shortstat || "No shortstat."}\n\n### Local Uncommitted Changes\nStaged:\n${repo.uncommitted.cachedNameStatus || "none"}\n\nUnstaged:\n${repo.uncommitted.worktreeNameStatus || "none"}\n\nUntracked:\n${repo.uncommitted.untrackedFiles || "none"}\n\n### GitNexus\n${repo.gitnexus.map((item) => `${item.label}: ${item.skipped ? "skipped" : item.ok ? "ok" : "failed"}`).join("; ") || "not run"}\n\n### Repo Prompt\n${repo.promptPath || "not written"}`)
    .join("\n\n---\n\n");

  return `# Org Sync Report Task

You are producing a morning engineering intelligence report for an org folder.

Use Git summaries as factual evidence. Use GitNexus status as structural context. Do not invent behavior; if before/after behavior is unclear, say what source context is missing.

## Run
- Org root: ${runSummary.options.orgRoot}
- Since: ${runSummary.options.since}
- Baseline: ${runSummary.options.baseline || "none"}
- Generated at: ${runSummary.generatedAt}

## Required Markdown Output
1. Executive summary.
2. Repo-wise changes.
3. Developer-wise details: who did what, grouped by repo and author.
4. Impacted flows/modules where evidence supports them.
5. Before vs after behavior for meaningful changes.
6. Risk classification and edge cases.
7. Recommended checks for the team today.
8. Failed/skipped repos.

## Repo Inputs
${repoSections || "No repositories analyzed."}
`;
}

function buildFallbackReport(runSummary) {
  const sections = runSummary.repos.map(buildDeterministicRepoReport).join("\n---\n\n");
  const failures = runSummary.failures.length
    ? runSummary.failures.map((failure) => `- ${failure.repo || "org"}: ${failure.error}`).join("\n")
    : "- None.";

  return `# Org Sync Report - ${new Date(runSummary.generatedAt).toLocaleDateString("en-CA")}

Generated by \`org-sync\`.

## Executive Summary
- Repos analyzed: ${runSummary.repos.length}
- Repos with changes: ${runSummary.repos.filter(hasMeaningfulChanges).length}
- Critical product-flow hits: ${runSummary.repos.reduce((count, repo) => count + (repo.productFlows || []).filter((flow) => flow.severity === "critical").length, 0)}
- High-risk repos: ${runSummary.repos.filter((repo) => (repo.riskTags || []).some((risk) => risk.severity === "high")).length}
- Deep review recommended: ${runSummary.repos.some((repo) => repo.review?.deepRecommended) ? "yes" : "no"}
- Failures: ${runSummary.failures.length}
- LLM status: ${runSummary.llm?.status || "not run"}

${runSummary.llm?.status === "skipped" ? "OpenCode/LLM was skipped; this report is deterministic and does not infer before/after behavior beyond factual Git summaries." : "OpenCode/LLM did not produce the final report; this fallback report is deterministic."}

---

${sections || "No repositories analyzed."}

---

## Failed or Skipped Repos
${failures}

## Manual LLM Prompt
${runSummary.orgPromptPath ? `Use this prompt with OpenCode if you want behavioral before/after reasoning: \`${runSummary.orgPromptPath}\`.` : "No org prompt was written."}
`;
}

async function invokeOpenCode(promptPath, outputPath, options) {
  const parts = shellWords(options.opencodeCmd);
  if (parts.length === 0) return { status: "failed", error: "Empty --opencode-cmd" };
  const cmd = parts[0];
  const args = [
    ...parts.slice(1),
    "Read the attached org sync prompt and produce the requested Markdown report.",
    "--file",
    promptPath,
  ];
  const result = await run(cmd, args, { cwd: options.orgRoot, timeoutMs: 600_000 });
  if (!result.ok) {
    return { status: "failed", command: result.command, error: result.stderr.trim() || result.error || "OpenCode failed" };
  }
  await writeFile(outputPath, result.stdout, "utf8");
  return { status: "completed", command: result.command, outputPath };
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function listMarkdownFilesRecursive(dir, root = dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFilesRecursive(fullPath, root));
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files;
}

async function assertMarkdownOnlyNotes(notesDir) {
  if (!existsSync(notesDir)) return;
  const files = await listMarkdownFilesRecursive(notesDir, notesDir);
  const nonMarkdown = files.filter((file) => !file.endsWith(".md"));
  if (nonMarkdown.length > 0) {
    throw new Error(`Obsidian notes directory contains non-Markdown files: ${nonMarkdown.join(", ")}`);
  }
}

function extractExistingMarkdownLinks(content) {
  const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  return Array.from(matches, (match) => match[1]);
}

async function updateRepoNote(notesDir, repoName, dailyLink, dailyLabel) {
  const reposDir = path.join(notesDir, "repos");
  await mkdir(reposDir, { recursive: true });
  const repoFileName = sanitizeRepoFileName(repoName);
  const repoPath = path.join(reposDir, `${repoFileName}.md`);
  const existing = existsSync(repoPath) ? await readFile(repoPath, "utf8") : "";
  const links = new Set(extractExistingMarkdownLinks(existing).filter((link) => /^\d{4}\/\d{2}\//.test(link)));
  links.add(dailyLink);
  const sorted = Array.from(links).sort().reverse();
  const body = `---\ntype: org-sync-repo\nrepo: ${yamlString(repoName)}\n---\n\n# ${repoName}\n\n## Recent Reports\n\n${sorted.map((link) => `- ${noteLink(link, link === dailyLink ? dailyLabel : path.basename(link))}`).join("\n")}\n`;
  await writeFile(repoPath, body, "utf8");
  return `repos/${repoFileName}`;
}

async function writeIndexNote(notesDir, repoLinks) {
  const files = await listMarkdownFilesRecursive(notesDir, notesDir);
  const dailyLinks = files
    .filter((file) => /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .map((file) => file.replace(/\.md$/, ""))
    .sort()
    .reverse();
  const repoSection = Array.from(repoLinks.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, link]) => `- ${noteLink(link, repo)}`)
    .join("\n");
  const body = `---\ntype: org-sync-index\n---\n\n# Org Sync Reports\n\n## Recent Reports\n\n${dailyLinks.map((link) => `- ${noteLink(link, path.basename(link))}`).join("\n") || "- No reports yet."}\n\n## Repositories\n\n${repoSection || "- No repositories yet."}\n`;
  await writeFile(path.join(notesDir, "_index.md"), body, "utf8");
}

async function writeObsidianNotes(runSummary, reportPath, options) {
  const generatedAt = new Date(runSummary.generatedAt);
  const { yyyyMmDd, year, month } = datePartsForNotes(generatedAt);
  const dailyDir = path.join(options.notesDir, year, month);
  await mkdir(dailyDir, { recursive: true });

  const dailyLink = `${year}/${month}/${yyyyMmDd}`;
  const dailyNotePath = path.join(dailyDir, `${yyyyMmDd}.md`);
  const reportContent = await readFile(reportPath, "utf8");
  const repoLinks = new Map();

  for (const repo of runSummary.repos) {
    const repoLink = await updateRepoNote(options.notesDir, repo.name, dailyLink, yyyyMmDd);
    repoLinks.set(repo.name, repoLink);
  }

  const reposYaml = runSummary.repos.map((repo) => `  - ${yamlString(repo.name)}`).join("\n");
  const repoLinksMd = runSummary.repos
    .map((repo) => `- ${noteLink(repoLinks.get(repo.name), repo.name)}`)
    .join("\n");
  const dailyNote = `---\ntype: org-sync-report\ndate: ${yamlString(yyyyMmDd)}\ngenerated_at: ${yamlString(runSummary.generatedAt)}\norg_root: ${yamlString(options.orgRoot)}\nraw_report: ${yamlString(reportPath)}\nllm_status: ${yamlString(runSummary.llm?.status || "not run")}\nrepos:\n${reposYaml || "  []"}\n---\n\n# Org Sync - ${yyyyMmDd}\n\n## Links\n\n- Index: ${noteLink("_index")}\n- Raw report: \`${reportPath}\`\n\n## Repositories\n\n${repoLinksMd || "- No repositories analyzed."}\n\n---\n\n${reportContent}\n`;

  await writeFile(dailyNotePath, dailyNote, "utf8");
  await writeIndexNote(options.notesDir, repoLinks);
  await assertMarkdownOnlyNotes(options.notesDir);
  return { dailyNotePath, dailyLink };
}

async function analyzeRepo(repo, options) {
  const warnings = [];
  const before = await collectGitMetadata(repo);
  if (before.dirty) warnings.push("Working tree was dirty before sync; pull may fail or analysis may include local changes.");

  const pullResults = await pullRepo(repo, options);
  for (const result of pullResults) {
    if (!result.skipped && !result.ok) warnings.push(`${result.command} failed: ${result.stderr.trim() || result.error}`);
  }

  const afterPull = await collectGitMetadata(repo);
  if (afterPull.dirty) warnings.push("Working tree is dirty after pull phase; report may include local uncommitted changes.");

  const base = await resolveBase(repo, options);
  if (base.error) warnings.push(`Base resolution warning: ${base.error}`);

  const gitSummary = await collectGitSummary(repo, base, options);
  for (const error of gitSummary.errors) warnings.push(`${error.command} failed: ${error.error}`);

  const uncommitted = await collectUncommittedSummary(repo, options);
  for (const error of uncommitted.errors) warnings.push(`${error.command} failed: ${error.error}`);

  const gitnexus = await runGitNexus(repo, options);
  for (const result of gitnexus) {
    if (!result.skipped && !result.ok) warnings.push(`GitNexus ${result.label} failed: ${result.stderr || result.error || "unknown error"}`);
  }

  const afterAnalysis = await collectGitMetadata(repo);
  if (!afterPull.dirty && afterAnalysis.dirty) {
    warnings.push("Working tree became dirty during analysis; GitNexus or another local hook may have modified files.");
  }

  const draftSummary = {
    name: repo.name,
    path: repo.path,
    before,
    after: afterAnalysis,
    afterPull,
    pullResults,
    base,
    git: gitSummary,
    uncommitted,
    gitnexus,
    warnings,
  };

  const productFlows = tagProductFlows(draftSummary);
  const riskTags = tagRisks(draftSummary);
  return { ...draftSummary, productFlows, riskTags, review: reviewRecommendation(productFlows, riskTags) };
}

async function writeRepoArtifacts(repoSummary, outputDir) {
  const repoDir = path.join(outputDir, "repos", repoSummary.name);
  await mkdir(repoDir, { recursive: true });

  const prompt = buildRepoPrompt(repoSummary);
  const gitSummary = `# ${repoSummary.name} Git Summary\n\n## Commits\n${repoSummary.git.log || "No commits."}\n\n## Developer-wise Changes\n${repoSummary.git.developerSummary || "No developer summary."}\n\n## Diff Stat\n${repoSummary.git.stat || "No stat."}\n\n## Changed Files\n${repoSummary.git.nameStatus || "No changed files."}\n\n## Local Uncommitted Changes\n\n### Staged\n${repoSummary.uncommitted.cachedNameStatus || "No staged changes."}\n\n### Unstaged\n${repoSummary.uncommitted.worktreeNameStatus || "No unstaged changes."}\n\n### Untracked\n${repoSummary.uncommitted.untrackedFiles || "No untracked files."}\n`;
  const promptPath = path.join(repoDir, "llm-prompt.md");

  await writeFile(path.join(repoDir, "git-summary.md"), gitSummary, "utf8");
  await writeFile(promptPath, prompt, "utf8");
  await writeJson(path.join(repoDir, "summary.json"), { ...repoSummary, promptPath });

  return { ...repoSummary, promptPath, repoDir };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const orgStats = await stat(options.orgRoot).catch(() => null);
  if (!orgStats?.isDirectory()) throw new Error(`Org root does not exist or is not a directory: ${options.orgRoot}`);
  await ensureGit();

  const repos = await discoverRepos(options.orgRoot, options.repos);
  if (repos.length === 0) {
    throw new Error(`No git repositories found under ${options.orgRoot}${options.repos.length ? ` matching ${options.repos.join(", ")}` : ""}`);
  }

    console.log(`Org root: ${options.orgRoot}`);
  console.log(`Repos: ${repos.map((repo) => repo.name).join(", ")}`);
  console.log(`Output: ${options.outputDir}`);
  console.log(`Notes: ${options.notes ? options.notesDir : "disabled"}`);
  console.log(`Pull: ${options.pull ? "yes" : "no"}; GitNexus: ${options.gitnexus ? options.gitnexusAnalyze ? "analyze+status" : "status" : "no"}; OpenCode: ${options.llm ? "yes" : "no"}`);
  console.warn("Prompt/report artifacts may contain code, diffs, paths, and sensitive context. Review before sharing or committing.");

  if (options.dryRun) {
    console.log("\nDry run only. Planned actions:");
    for (const repo of repos) {
      const gitnexusPlan = options.gitnexus ? `run GitNexus ${options.gitnexusAnalyze ? "analyze/status" : "status"}` : "skip GitNexus";
      console.log(`- ${repo.name}: ${options.pull ? "fetch + pull --ff-only when clean, " : ""}collect git summary, ${gitnexusPlan}${options.llm ? ", invoke OpenCode" : ", write local report/prompts"}`);
    }
    console.log(`Notes: ${options.notes ? options.notesDir : "disabled"}`);
    return;
  }

  await mkdir(options.outputDir, { recursive: true });

  const runSummary = {
    generatedAt: new Date().toISOString(),
    options: { ...options },
    repos: [],
    failures: [],
    llm: { status: options.llm ? "pending" : "skipped" },
    orgPromptPath: null,
    founderSignalsPath: null,
    deepReviewPromptPath: null,
    releaseReviewPromptPath: null,
    agencyBriefsPath: null,
    developers: [],
  };

  for (const repo of repos) {
    console.log(`\n[${repo.name}] analyzing...`);
    try {
      const summary = await analyzeRepo(repo, options);
      const withArtifacts = await writeRepoArtifacts(summary, options.outputDir);
      runSummary.repos.push(withArtifacts);
      console.log(`[${repo.name}] done (${hasMeaningfulChanges(withArtifacts) ? "changes found" : "no selected-window changes"})`);
    } catch (error) {
      runSummary.failures.push({ repo: repo.name, error: error.message });
      console.error(`[${repo.name}] failed: ${error.message}`);
    }
  }

  const orgPrompt = buildOrgPrompt(runSummary);
  const orgPromptPath = path.join(options.outputDir, "org-prompt.md");
  runSummary.orgPromptPath = orgPromptPath;
  await writeFile(orgPromptPath, orgPrompt, "utf8");

  const reportPath = path.join(options.outputDir, "report.md");
  if (options.llm) {
    console.log("\nInvoking OpenCode for org report...");
    console.warn("OpenCode may send prompt content according to your configured provider. Use --no-llm for local-only output.");
    runSummary.llm = await invokeOpenCode(orgPromptPath, reportPath, options);
  }

  if (runSummary.llm.status !== "completed") {
    await writeFile(reportPath, buildFallbackReport(runSummary), "utf8");
  }

  let founderSignals = buildFounderSignals(runSummary, reportPath);
  if (options.deep) {
    const deepPath = path.join(options.outputDir, "deep-review-prompt.md");
    runSummary.deepReviewPromptPath = deepPath;
    founderSignals.deepReviewPromptPath = deepPath;
    await writeFile(deepPath, buildDeepReviewPrompt(runSummary, founderSignals), "utf8");
  }
  if (options.release) {
    const releasePath = path.join(options.outputDir, "release-review-prompt.md");
    runSummary.releaseReviewPromptPath = releasePath;
    founderSignals.releaseReviewPromptPath = releasePath;
    await writeFile(releasePath, buildReleaseReviewPrompt(runSummary, founderSignals), "utf8");
  }
  founderSignals = buildFounderSignals(runSummary, reportPath);
  const founderSignalsPath = path.join(options.outputDir, "founder-signals.json");

  const developers = aggregateDevelopers(runSummary.repos);

  const { briefsDir, briefs } = buildAgencyBriefs(runSummary, founderSignals, options.outputDir);
  await mkdir(briefsDir, { recursive: true });
  const agencyBriefIndex = buildAgencyBriefIndex();
  await writeJson(path.join(briefsDir, "index.json"), agencyBriefIndex);
  for (const [fileName, content] of Object.entries(briefs)) {
    await writeFile(path.join(briefsDir, fileName), content, "utf8");
  }
  const agencyBriefsPath = briefsDir;

  founderSignals.developers = developers;
  founderSignals.agencyBriefsPath = agencyBriefsPath;
  runSummary.founderSignalsPath = founderSignalsPath;
  runSummary.developers = developers;
  runSummary.agencyBriefsPath = agencyBriefsPath;
  await writeJson(founderSignalsPath, founderSignals);

  await writeJson(path.join(options.outputDir, "run-summary.json"), runSummary);

  let notesResult = null;
  if (options.notes) {
    notesResult = await writeObsidianNotes(runSummary, reportPath, options);
  }

  console.log(`\nReport: ${reportPath}`);
  console.log(`Founder signals: ${founderSignalsPath}`);
  console.log(`Agency briefs: ${agencyBriefsPath}`);
  if (runSummary.deepReviewPromptPath) console.log(`Deep review prompt: ${runSummary.deepReviewPromptPath}`);
  if (runSummary.releaseReviewPromptPath) console.log(`Release review prompt: ${runSummary.releaseReviewPromptPath}`);
  if (notesResult) console.log(`Obsidian note: ${notesResult.dailyNotePath}`);
  if (runSummary.llm.status !== "completed") {
    console.log(`OpenCode status: ${runSummary.llm.status}${runSummary.llm.error ? ` (${runSummary.llm.error})` : ""}`);
    console.log(`Manual prompt: ${orgPromptPath}`);
  }
}

main().catch((error) => {
  console.error(`org-sync failed: ${error.message}`);
  process.exitCode = 1;
});
