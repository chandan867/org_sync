#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadOrgRules, filterUntrackedNoise } from "./lib/org-config.mjs";

const DEFAULT_SINCE = "24 hours ago";
const DEFAULT_MAX_DIFF_BYTES = 80_000;
const COMMAND_TIMEOUT_MS = 120_000;

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
    untrackedFiles: filterUntrackedNoise(untracked.stdout),
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
    let pathMatchCount = 0;
    for (const file of changedFiles) {
      if (rule.pathPatterns?.some((pattern) => pattern.test(file.path))) { evidence.push(`path: ${file.path}`); pathMatchCount++; }
      if (file.previousPath && rule.pathPatterns?.some((pattern) => pattern.test(file.previousPath))) { evidence.push(`path: ${file.previousPath}`); pathMatchCount++; }
    }
    let hasTextMatch = false;
    if (allowTextEvidence && rule.textPatterns?.some((pattern) => pattern.test(evidenceText))) {
      evidence.push("text: keyword matched in commits/diff excerpt");
      hasTextMatch = true;
    }
    let hasDerivedMatch = false;
    if (rule.derived?.(repoSummary)) { evidence.push("state: derived repo condition matched"); hasDerivedMatch = true; }
    if (!evidence.length) return null;
    // Confidence: each path match +20 (cap 3 matches = 60), text match +15, derived +20. Max 100.
    const confidence = Math.min(100, Math.min(pathMatchCount, 3) * 20 + (hasTextMatch ? 15 : 0) + (hasDerivedMatch ? 20 : 0));
    return { id: rule.id, label: rule.label, severity: rule.severity, confidence, evidence: Array.from(new Set(evidence)).slice(0, 6) };
  }).filter(Boolean);
}

function tagProductFlows(repoSummary, productFlowRules) {
  return matchRules(productFlowRules, repoSummary);
}

function tagRisks(repoSummary, riskRules) {
  return matchRules(riskRules, repoSummary);
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
  return tags?.length ? tags.map((tag) => `- ${tag.label} (${tag.severity}, ${tag.confidence ?? "?"}% confidence) — ${tag.evidence.join("; ")}`).join("\n") : "- None detected.";
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

async function buildAgencyBriefs(runSummary, founderSignals, outputDir, options) {
  const briefsDir = path.join(outputDir, "agency-briefs");
  const devs = aggregateDevelopers(runSummary.repos);

  function buildEvidenceContext(domain) {
    const changedRepos = founderSignals.repos.filter((r) => (r.commits || []).length > 0 || (r.changedFiles || []).length > 0);
    const repoTable = changedRepos.map((r) => {
      const flows = (r.productFlows || []).map((f) => `${f.label} (${f.severity}, ${f.confidence ?? "?"}%)`).join(", ") || "none";
      const risks = (r.riskTags || []).map((t) => `${t.label} (${t.severity}, ${t.confidence ?? "?"}%)`).join(", ") || "none";
      const commits = (r.commits || []).length;
      return "- **" + r.name + "** (" + commits + " commits): flows=[" + flows + "], risks=[" + risks + "]";
    }).join("\n") || "No committed changes in this window.";
    const devTableLines = devs.map(function (d) {
      return "- **" + d.name + "** <" + d.email + ">: " + d.commits + " commits across [" + d.repos.join(", ") + "]";
    }).join("\n") || "No developer data.";

    const allFlows = founderSignals.repos.flatMap(function (r) { return r.productFlows || []; });
    const uniqueFlows = [...new Map(allFlows.map(function (f) { return [f.id, f]; })).values()];

    const flowLines = uniqueFlows.length
      ? uniqueFlows.map(function (f) { return "- " + f.label + " (" + f.severity + ", " + (f.confidence ?? "?") + "% confidence)"; }).join("\n")
      : "- None detected.";
    const riskLines = founderSignals.repos.flatMap(function (r) {
      return (r.riskTags || []).map(function (t) {
        return "- " + t.label + " (" + t.severity + ", " + (t.confidence ?? "?") + "% confidence) — repo: " + r.name;
      });
    }).join("\n") || "- None detected.";
    const baseStr = founderSignals.window.baseline ? " (baseline: " + founderSignals.window.baseline + ")" : "";

    return "## Org Context\n\n"
      + "- Org: " + founderSignals.orgRoot + "\n"
      + "- Date: " + founderSignals.generatedAt.slice(0, 10) + "\n"
      + "- Window: " + founderSignals.window.since + baseStr + "\n"
      + "- Domain focus: " + domain + "\n\n"
      + "## Changed Repositories\n\n" + repoTable + "\n\n"
      + "## Product Flows Touched\n\n" + flowLines + "\n\n"
      + "## Risk Tags\n\n" + riskLines + "\n\n"
      + "## Developers\n\n" + devTableLines;
  }

  function buildBriefPrompt(domainLabel, domainRole, outputSections, evidenceContext, extraContext) {
    return `# Agency Brief Prompt: ${domainLabel}

You are the ${domainRole} for this company. You have just received the engineering sync report for the past cycle.
Your job is to produce the **${domainLabel} Agency Brief** — a focused, actionable document for ${domainLabel.toLowerCase()} decision-making.

Base your brief ONLY on the evidence below. Do not invent facts. Flag gaps explicitly as "insufficient evidence".

${evidenceContext}${extraContext ? "\n\n" + extraContext : ""}

## Required Output

Write a Markdown document titled "# Agency Brief: ${domainLabel}" with these sections:

${outputSections}

Keep each section tight and actionable. Write for a busy founder — no filler, no padding.
`;
  }

  const productExtra = founderSignals.repos.map(function (r) {
    const files = (r.changedFiles || []).length
      ? r.changedFiles.map(function (f) { return "- " + f.status + " " + f.path; }).join("\n")
      : "- No changed files.";
    return "### " + r.name + "\n" + files;
  }).join("\n\n");

  const devDetails = devs.map(function (d) {
    const subjects = d.commitSubjects.length ? d.commitSubjects.map(function (s) { return "  - " + s; }).join("\n") : "";
    const flows = d.productFlows.map(function (f) { return f.label + " (" + f.severity + ")"; }).join(", ") || "none";
    const risks = d.riskTags.map(function (t) { return t.label + " (" + t.severity + ")"; }).join(", ") || "none";
    return "### " + d.name + " <" + d.email + ">\n\n"
      + "- Commits: " + d.commits + "\n"
      + "- Repos: " + d.repos.join(", ") + "\n"
      + "- Commit subjects:\n" + (subjects || "  - (none)") + "\n"
      + "- Related product flows: " + flows + "\n"
      + "- Related risk tags: " + risks + "\n";
  }).join("\n") || "No developer data found.";

  const BRIEFS = [
    {
      file: "product.md",
      domain: "Product",
      role: "Head of Product",
      sections: `### What Changed (Product Lens)
One paragraph: which user journeys or product capabilities changed? What does the product do differently now?

### Breaking Changes / Behavioral Shifts
List any breaking changes or behavior shifts for existing users. If none, say so explicitly.

### QA Attention Areas
Which feature areas need QA? Be specific about flows and repos.

### Product Metrics at Risk
Which metrics (engagement, retention, conversion, activation) could be affected?

### Release Gate Checklist
What must be verified before the next release? List as checkboxes.`,
      extra: "## Changed File Summary by Repo\n\n" + productExtra,
    },
    {
      file: "gtm.md",
      domain: "GTM",
      role: "Head of GTM / Growth",
      sections: `### New Sales Stories / Demo Talking Points
Which changes create new demo moments or sales proof points?

### Risky to Demo or Sell (pre-validation)
Which changes should NOT be demoed or mentioned until further validated?

### New Customer Segments or Use Cases Unlocked
Do these changes open new markets or remove blockers for specific ICPs?

### Narrative Strength / Weakness
Which product narratives (speed, reliability, platform, etc.) got stronger or weaker?

### Pricing / Packaging / Messaging Implications
Should messaging, pricing tiers, or packaging be updated?`,
      extra: null,
    },
    {
      file: "sales.md",
      domain: "Sales",
      role: "Head of Sales",
      sections: `### Demo-Ready vs Not-Ready (table)
| Repo / Feature | Demo Ready? | Notes |

### Objection Handling Updates
Which new objections could these changes introduce, and which existing objections do they address?

### New Capabilities for Prospects
New integrations, APIs, or features that sales can offer.

### Pipeline Deal Updates
Should any open deals be accelerated, decelerated, or have their close criteria updated?

### Enterprise Sales Considerations
Any compliance, security, reliability, or SLA changes relevant to enterprise accounts?`,
      extra: null,
    },
    {
      file: "marketing.md",
      domain: "Marketing",
      role: "Head of Marketing",
      sections: `### Content Angles Available
What blog posts, LinkedIn posts, or case study angles does this evidence support? List 3–5 specific ideas.

### Proof Points Gained
What new proof points (performance benchmarks, feature milestones, technical depth) are now available?

### Customer-Facing Announcements
Should any changes be announced publicly? What tone and channel?

### Website / Docs / Demo Updates Needed
What marketing assets need updating based on these changes?

### Social Proof / Community Content
What developer or user community content could be generated from recent progress?`,
      extra: null,
    },
    {
      file: "engineering.md",
      domain: "Engineering",
      role: "Engineering Lead / CTO",
      sections: `### Technical Risk Summary (HIGH / MEDIUM / LOW per repo)
| Repo | Risk | Key Concern |

### Critical Findings
Schema changes, API contract breaks, auth/security implications — anything that could cause incidents.

### Code Review and QA Gates
Which repos need mandatory review or manual QA before shipping? Why?

### Architectural Concerns
Cross-repo dependencies, shared contract changes, or structural debt introduced.

### Observability / Monitoring Gaps
What monitoring, logging, or alerting is missing or needs updating?

### Release Gate Recommendation
Should any release be blocked? If yes, state exactly what condition must be met.`,
      extra: "## Developer Activity Detail\n\n" + devDetails,
    },
    {
      file: "customer-success.md",
      domain: "Customer Success",
      role: "Head of Customer Success",
      sections: `### Customer-Facing Changes
Which changes affect how customers use the product day-to-day?

### Communication Required
Which changes need proactive customer communication, changelog entries, or support docs?

### Known Issues / Regressions in Changed Areas
List any regressions or known gaps introduced. If none confirmed, say so.

### Support Team Briefing
What should support know about behavioral or UI changes before customers call in?

### Customer Health Risks
What customer-facing metrics (uptime, response time, error rates) may be affected? For which segments?

### Breaking Changes / Migration Steps
Are there deprecations, API changes, or migration steps customers must take?`,
      extra: null,
    },
  ];

  const evidenceContext = buildEvidenceContext("(per-domain, see prompt)");
  const briefs = {};

  await mkdir(briefsDir, { recursive: true });

  for (const brief of BRIEFS) {
    const domainEvidence = buildEvidenceContext(brief.domain);
    if (options?.llm) {
      const prompt = buildBriefPrompt(brief.domain, brief.role, brief.sections, domainEvidence, brief.extra);
      const promptPath = path.join(briefsDir, `${brief.file.replace(".md", "")}-prompt.md`);
      await writeFile(promptPath, prompt, "utf8");
      console.log(`\n[agency-brief:${brief.domain.toLowerCase()}] Invoking OpenCode...`);
      const result = await invokeOpenCode(promptPath, path.join(briefsDir, brief.file), options);
      if (result.status === "completed") {
        briefs[brief.file] = null; // already written by invokeOpenCode
        continue;
      }
      console.warn(`[agency-brief:${brief.domain.toLowerCase()}] OpenCode failed (${result.error || result.status}), falling back to evidence.`);
    }
    // Fallback: structured evidence brief
    const header = `# Agency Brief: ${brief.domain}\n\n`
      + `_Structured evidence — run without --no-llm for LLM-synthesized analysis._\n\n`;
    briefs[brief.file] = header + domainEvidence + (brief.extra ? "\n\n" + brief.extra : "") + "\n";
  }

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
  const flows = repoSummary.productFlows || [];
  const risks = repoSummary.riskTags || [];
  const commits = (repoSummary.git.log || "").split("\n").filter(Boolean);
  const flowLines = flows.length
    ? flows.map((f) => `- ${f.label} (${f.severity}, ${f.confidence}% confidence): ${f.evidence.slice(0, 2).join("; ")}`).join("\n")
    : "- None detected.";
  const riskLines = risks.length
    ? risks.map((r) => `- ${r.label} (${r.severity}, ${r.confidence}% confidence): ${r.evidence.slice(0, 2).join("; ")}`).join("\n")
    : "- None.";
  const commitList = commits.length
    ? commits.slice(0, 10).map((line) => `- ${line}`).join("\n") + (commits.length > 10 ? `\n- ... and ${commits.length - 10} more` : "")
    : "- No commits in this window.";

  return `# Per-Repo Product Intelligence: ${repoSummary.name}

You are a co-founder reviewing what changed in this repository. Your audience is the founding team — not engineers.
Translate technical changes into product and business language. Do not list file names as primary output.
You MAY call GitNexus MCP tools (gitnexus impact, gitnexus detect_changes) to understand blast radius before writing your analysis.
Base all claims on the evidence below. If before/after is unclear, say so.

## Repository
- Name: ${repoSummary.name}
- Branch: ${repoSummary.after.branch || "unknown"}
- Change scope: ${repoSummary.git.shortstat || "no committed changes"}
- Dirty after sync: ${repoSummary.after.dirty ? "yes" : "no"}

## Pre-analyzed Product Flows (by file path matching)
${flowLines}

## Pre-analyzed Risk Signals
${riskLines}

## Commits
${commitList}

## Developer Activity
${repoSummary.git.developerSummary || "No commits in this window."}

## GitNexus Structural Analysis
${formatGitNexusResults(repoSummary.gitnexus)}

## Diff Excerpt
${repoSummary.git.diffExcerpt || "No diff excerpt."}

## Local Uncommitted Changes
Staged: ${repoSummary.uncommitted.cachedNameStatus || "none"}
Unstaged: ${repoSummary.uncommitted.worktreeNameStatus || "none"}
Untracked: ${repoSummary.uncommitted.untrackedFiles || "none"}

## Required Output

### What Changed (Product Lens)
One short paragraph: what feature or user flow changed? What does the product do differently now?

### Demo Readiness
Can this repo's changes be demoed today? Answer: yes / no / with caveats — and state the specific caveats.

### Business Risk
Any schema changes, API breaks, auth changes, or user-facing regressions? Flag what a founder needs to decide before shipping.

### Who Did What
One bullet per developer: name and what they worked on — in product terms, not file terms.
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

function deterministicRiskLevel(repoSummary) {
  const hasCritical = (repoSummary.productFlows || []).some((f) => f.severity === "critical");
  const hasHighRisk = (repoSummary.riskTags || []).some((r) => r.severity === "high");
  if (hasCritical || hasHighRisk) return "HIGH";
  if (repoSummary.after.dirty || repoSummary.git.errors.length) return "MEDIUM";
  return hasMeaningfulChanges(repoSummary) ? "LOW" : "NONE";
}

function buildDeterministicRepoReport(repoSummary) {
  const flows = repoSummary.productFlows || [];
  const risks = repoSummary.riskTags || [];
  const riskLevel = deterministicRiskLevel(repoSummary);
  const commits = (repoSummary.git.log || "").split("\n").filter(Boolean);
  const changedFiles = repoChangedFiles(repoSummary);

  const flowLines = flows.length
    ? flows.map((f) => `| ${f.label} | ${f.severity.toUpperCase()} | ${f.confidence}% | ${f.evidence[0] || "-"} |`).join("\n")
    : "| — | — | — | No flows detected |";
  const riskLines = risks.length
    ? risks.map((r) => `| ${r.label} | ${r.severity.toUpperCase()} | ${r.confidence}% | ${r.evidence[0] || "-"} |`).join("\n")
    : "| — | — | — | No risk signals |";

  const filesByArea = {};
  for (const f of changedFiles) {
    const area = f.path.split("/")[0] || "root";
    filesByArea[area] = (filesByArea[area] || 0) + 1;
  }
  const fileAreaSummary = Object.entries(filesByArea).map(([area, count]) => `${area} (${count})`).join(", ") || "none";

  return `## ${repoSummary.name} — Risk: ${riskLevel}

**Scope:** ${repoSummary.git.shortstat || "no committed changes"} | **Files by area:** ${fileAreaSummary}
**Branch:** ${repoSummary.after.branch || "unknown"} | **Uncommitted work:** ${repoSummary.after.dirty ? "yes" : "no"}

### Product Flows Touched
| Flow | Severity | Confidence | Top Evidence |
|------|----------|------------|--------------|
${flowLines}

### Risk Signals
| Signal | Severity | Confidence | Top Evidence |
|--------|----------|------------|--------------|
${riskLines}

### What the Team Shipped
${commits.length ? commits.slice(0, 8).map((line) => `- ${line}`).join("\n") + (commits.length > 8 ? `\n- ... and ${commits.length - 8} more commits` : "") : "- No commits in selected window."}

### Who Did What
${repoSummary.git.developerSummary || "No committed developer activity."}

### Work in Progress (not yet committed)
${repoSummary.uncommitted.cachedNameStatus ? `Staged:\n${repoSummary.uncommitted.cachedNameStatus.split("\n").map((l) => `- ${l}`).join("\n")}` : "Staged: none."}
${repoSummary.uncommitted.worktreeNameStatus ? `\nUnstaged:\n${repoSummary.uncommitted.worktreeNameStatus.split("\n").map((l) => `- ${l}`).join("\n")}` : "\nUnstaged: none."}
${repoSummary.uncommitted.untrackedFiles ? `\nNew files (untracked):\n${repoSummary.uncommitted.untrackedFiles.split("\n").map((l) => `- ${l}`).join("\n")}` : ""}

### Deep Review
${repoSummary.review?.deepRecommended ? `**RECOMMENDED** — ${repoSummary.review.reasons.join("; ")}` : "Not triggered."}
${repoSummary.warnings.length ? `\n**Warnings:** ${repoSummary.warnings.join(" | ")}` : ""}
`;
}

function buildOrgRepoSection(repo) {
  const flows = repo.productFlows || [];
  const risks = repo.riskTags || [];
  const commits = (repo.git.log || "").split("\n").filter(Boolean);
  const changedFiles = repoChangedFiles(repo);

  // Summarize changed files by top-level directory area rather than listing every path
  const filesByArea = {};
  for (const f of changedFiles) {
    const parts = f.path.split("/");
    const area = parts.length > 1 ? parts[0] : "root";
    filesByArea[area] = (filesByArea[area] || 0) + 1;
  }
  const fileAreaSummary = Object.entries(filesByArea).map(([area, count]) => `${area}(${count})`).join(", ") || "none";

  const flowSummary = flows.length
    ? flows.map((f) => `- **${f.label}** [${f.severity}, ${f.confidence}% confidence]`).join("\n")
    : "- None detected";
  const riskSummary = risks.length
    ? risks.map((r) => `- **${r.label}** [${r.severity}]`).join("\n")
    : "- None";
  const commitList = commits.length
    ? commits.slice(0, 8).map((line) => `- ${line}`).join("\n") + (commits.length > 8 ? `\n- ... +${commits.length - 8} more` : "")
    : "- No commits in this window.";

  return `## ${repo.name}

**Scope:** ${repo.git.shortstat || "no committed changes"} | **Files by area:** ${fileAreaSummary}
**Review flag:** ${repo.review?.deepRecommended ? "DEEP REVIEW RECOMMENDED" : "routine"}
**GitNexus:** ${repo.gitnexus.map((item) => `${item.label}:${item.skipped ? "skipped" : item.ok ? "ok" : "FAILED"}`).join(", ") || "not run"}

### Product Flows (pre-analyzed)
${flowSummary}

### Risk Signals (pre-analyzed)
${riskSummary}

### Commits
${commitList}

### Developer Activity
${repo.git.developerSummary || "No committed activity."}

### In-Progress Work (uncommitted)
Staged: ${repo.uncommitted.cachedNameStatus || "none"}
Unstaged: ${repo.uncommitted.worktreeNameStatus || "none"}
Untracked meaningful files: ${repo.uncommitted.untrackedFiles || "none"}`;
}

function buildOrgPrompt(runSummary) {
  const repoSections = runSummary.repos
    .map(buildOrgRepoSection)
    .join("\n\n---\n\n");

  return `# Founder & Product Intelligence Briefing

You are a co-founder and product strategist reviewing what the engineering team shipped since the last sync.

Your audience is the founding team — NOT engineers. Translate technical changes into business and product language. Do not list file names or commit hashes as the primary output; surface them only as evidence where needed.

For each repo with meaningful changes, you MAY call GitNexus MCP tools (gitnexus impact, gitnexus detect_changes) to get blast radius and architectural impact. Include impact findings in the Engineering Risk section.

Base all claims strictly on the Git evidence provided. Do not invent behavior. If before/after is unclear, say so.

## Run Context
- Org root: ${runSummary.options.orgRoot}
- Since: ${runSummary.options.since}
- Baseline: ${runSummary.options.baseline || "none"}
- Generated at: ${runSummary.generatedAt}

## Required Markdown Output

### Executive Read
One paragraph — what is the most important thing that happened today? What changed that a founder must know about?

### What Changed (Product Lens)
For each repo with meaningful changes: what feature or user flow changed? Not what files changed — what does the product do differently now? Group by user-facing impact.

### Demo & Sales Readiness
- What can be demoed or sold today that could not before?
- What should NOT be demoed yet (risky or incomplete)?
- What objections does this progress address?

### Business Risks & Blockers
- What could break a demo, affect customers, or block a release?
- What needs the founder's attention or decision before shipping?
- Any schema changes, API breaks, or auth changes that need extra QA?

### Engineering Health
- Who is doing what? (developer-wise summary)
- What is the technical risk level? (LOW / MEDIUM / HIGH with reasons)
- What tests or manual checks are recommended?
- GitNexus impact findings if available.

### Recommended Moves (Top 3)
The three highest-leverage actions for the team today.

### Open Questions for Founder
What does the team need from the founder — decisions, context, or priorities?

## Repo Inputs
${repoSections || "No repositories analyzed."}
`;
}

function buildFallbackReport(runSummary) {
  const date = new Date(runSummary.generatedAt).toLocaleDateString("en-CA");
  const reposWithChanges = runSummary.repos.filter(hasMeaningfulChanges);
  const criticalFlowHits = runSummary.repos.reduce((n, r) => n + (r.productFlows || []).filter((f) => f.severity === "critical").length, 0);
  const highRiskRepos = runSummary.repos.filter((r) => deterministicRiskLevel(r) === "HIGH");
  const deepReviewRepos = runSummary.repos.filter((r) => r.review?.deepRecommended);
  const failures = runSummary.failures.length
    ? runSummary.failures.map((f) => `- ${f.repo || "org"}: ${f.error}`).join("\n")
    : "- None.";

  // Traffic-light table: one row per repo
  const repoTableRows = runSummary.repos.map((repo) => {
    const riskLevel = deterministicRiskLevel(repo);
    const emoji = riskLevel === "HIGH" ? "🔴" : riskLevel === "MEDIUM" ? "🟡" : riskLevel === "NONE" ? "⚪" : "🟢";
    const flows = (repo.productFlows || []).map((f) => f.label).join(", ") || "—";
    const commits = (repo.git.log || "").split("\n").filter(Boolean).length;
    const flag = repo.review?.deepRecommended ? "⚠️ deep review" : "—";
    return `| ${emoji} ${repo.name} | ${riskLevel} | ${commits} | ${flows} | ${flag} |`;
  }).join("\n");

  const sections = runSummary.repos.map(buildDeterministicRepoReport).join("\n---\n\n");
  const llmNote = runSummary.llm?.status === "skipped"
    ? "> LLM was skipped (`--no-llm`). This report is structured data only — no behavioral inference."
    : "> OpenCode did not complete. This is the deterministic fallback report.";

  return `# Org Sync — ${date}

${llmNote}

## Status at a Glance

| Repo | Risk | Commits | Flows Touched | Flags |
|------|------|---------|---------------|-------|
${repoTableRows || "| — | — | — | — | — |"}

**Summary:** ${reposWithChanges.length}/${runSummary.repos.length} repos changed · ${criticalFlowHits} critical flow hits · ${highRiskRepos.length} high-risk · ${deepReviewRepos.length} need deep review · ${runSummary.failures.length} failures

${deepReviewRepos.length ? `**Deep review needed:** ${deepReviewRepos.map((r) => r.name).join(", ")}` : ""}
${highRiskRepos.length ? `**High-risk repos:** ${highRiskRepos.map((r) => r.name).join(", ")}` : ""}

---

${sections || "No repositories analyzed."}

---

## Failures
${failures}

## To Get Behavioral Analysis
${runSummary.orgPromptPath ? `Run: \`opencode run "Analyze this org sync" --file ${runSummary.orgPromptPath}\`` : "No org prompt written — re-run without --no-llm."}
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

  const productFlows = tagProductFlows(draftSummary, options.orgRules.productFlows);
  const riskTags = tagRisks(draftSummary, options.orgRules.riskRules);
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

  // Load per-org rules (reads from vision/product-overview.md fenced blocks if present).
  const orgRules = await loadOrgRules(options.orgRoot);
  options.orgRules = orgRules;
  if (orgRules.source.found) {
    console.log(`Org rules: loaded from product-overview.md (productFlows=${orgRules.source.productFlows}, riskRules=${orgRules.source.riskRules})`);
  } else {
    console.log(`Org rules: using generic defaults (add fenced blocks to vision/product-overview.md to customize)`);
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

  const { briefsDir, briefs } = await buildAgencyBriefs(runSummary, founderSignals, options.outputDir, options);
  const agencyBriefIndex = buildAgencyBriefIndex();
  await writeJson(path.join(briefsDir, "index.json"), agencyBriefIndex);
  for (const [fileName, content] of Object.entries(briefs)) {
    if (content !== null) await writeFile(path.join(briefsDir, fileName), content, "utf8");
  }
  const agencyBriefsPath = briefsDir;

  founderSignals.developers = developers;
  founderSignals.agencyBriefsPath = agencyBriefsPath;
  runSummary.founderSignalsPath = founderSignalsPath;
  runSummary.developers = developers;
  runSummary.agencyBriefsPath = agencyBriefsPath;
  await writeJson(founderSignalsPath, founderSignals);

  await writeJson(path.join(options.outputDir, "run-summary.json"), runSummary);

  await updateGlobalIndex(options, runSummary, reportPath, founderSignals);

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

async function updateGlobalIndex(options, runSummary, reportPath, founderSignals) {
  const projectsRoot = path.dirname(options.orgRoot);
  const globalDir = path.join(projectsRoot, ".org-intel-global");
  const indexPath = path.join(globalDir, "index.json");
  const orgName = path.basename(options.orgRoot);

  let existing = { orgs: [] };
  try { existing = JSON.parse(await readFile(indexPath, "utf8")); } catch {}

  const orgEntry = {
    name: orgName,
    path: options.orgRoot,
    status: "org-synced",
    summary: founderSignals.summary || null,
    reportPath: path.relative(projectsRoot, reportPath),
  };

  const otherOrgs = (existing.orgs || []).filter((o) => o.name !== orgName);
  const index = {
    schemaVersion: 1,
    generatedAt: runSummary.generatedAt,
    projectsRoot,
    orgs: [orgEntry, ...otherOrgs],
  };

  try {
    await mkdir(globalDir, { recursive: true });
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`Warning: could not update global index: ${err.message}`);
  }
}

main().catch((error) => {
  console.error(`org-sync failed: ${error.message}`);
  process.exitCode = 1;
});
