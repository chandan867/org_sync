#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveAgentsRoot } from "./lib/org-config.mjs";
const DEFAULT_MAX_AGENT_BYTES = 120_000;
const MAX_CONTINUITY_FILE_BYTES = 40_000;
const CONTINUITY_DAYS = 7;
const COMMAND_TIMEOUT_MS = 600_000;

function usage() {
  return `founder-sync: turn org-sync reports into founder strategy, research, decisions, and todos.

Usage:
  founder-sync
  founder-sync --research
  founder-sync --no-llm
  npm run founder:sync -- --dry-run

Options:
  --org-root <path>          Folder containing org-sync outputs. Default: current working directory.
  --agents-root <path>       Agency agents folder. Default: ${DEFAULT_AGENTS_ROOT}.
  --questions <path>         Questions file. Default: <org-root>/vision/questions.md.
  --org-sync-report <path>   Specific org-sync report/note to analyze.
  --date <YYYY-MM-DD>        Output date. Default: today.
  --research                 Also produce vision/research/YYYY/MM/YYYY-MM-DD.md.
  --no-llm                   Do not invoke OpenCode; write prompt and fallback Markdown outputs. OpenCode is enabled by default.
  --dry-run                  Print planned actions without writing files or invoking OpenCode.
  --opencode-cmd <cmd>       OpenCode command. Default: "opencode run".
  --max-agent-bytes <n>      Max agency-agent Markdown bytes included. Default: ${DEFAULT_MAX_AGENT_BYTES}.
  --help                     Show this help.

  Outputs:
  vision/daily/YYYY/MM/YYYY-MM-DD.md
  vision/decisions/YYYY/MM/YYYY-MM-DD.md
  vision/research/YYYY/MM/YYYY-MM-DD.md with --research
  vision/todos.md
  founder-sync-runs/<timestamp>/prompt.md and response/fallback files

Notes:
  - OpenCode is invoked by default because LLM intelligence is part of the SOP.
  - OpenCode may send prompt content according to your configured provider. Use --no-llm for local-only output.
`;
}

function parseArgs(argv) {
  const options = {
    orgRoot: process.cwd(),
    agentsRoot: null,
    questionsPath: null,
    orgSyncReport: null,
    date: null,
    research: false,
    llm: true,
    dryRun: false,
    opencodeCmd: "opencode run",
    maxAgentBytes: DEFAULT_MAX_AGENT_BYTES,
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
      case "--agents-root":
        options.agentsRoot = path.resolve(next());
        break;
      case "--questions":
        options.questionsPath = path.resolve(next());
        break;
      case "--org-sync-report":
        options.orgSyncReport = path.resolve(next());
        break;
      case "--date":
        options.date = next();
        break;
      case "--research":
        options.research = true;
        break;
      case "--no-llm":
        options.llm = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--opencode-cmd":
        options.opencodeCmd = next();
        break;
      case "--max-agent-bytes": {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--max-agent-bytes must be a non-negative integer");
        options.maxAgentBytes = parsed;
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.visionDir = path.join(options.orgRoot, "vision");
  options.questionsPath ??= path.join(options.visionDir, "questions.md");
  // Resolve agentsRoot: explicit CLI value already set, otherwise derive from parent of orgRoot
  if (!options.agentsRoot) {
    options.agentsRoot = resolveAgentsRoot(null, path.dirname(options.orgRoot));
  }
  const now = new Date();
  options.generatedAt = now.toISOString();
  options.timestamp = timestampForPath(now);
  options.outputDate = options.date || now.toISOString().slice(0, 10);
  options.runDir = path.join(options.orgRoot, "founder-sync-runs", options.timestamp);
  return options;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function dateParts(yyyyMmDd) {
  const [year, month] = yyyyMmDd.split("-");
  return { year, month, yyyyMmDd };
}

function parseOutputDate(yyyyMmDd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) throw new Error(`Invalid --date value: ${yyyyMmDd}. Expected YYYY-MM-DD.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== yyyyMmDd) throw new Error(`Invalid --date value: ${yyyyMmDd}.`);
  return date;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function continuityDateKeys(outputDate, days = CONTINUITY_DAYS) {
  const end = parseOutputDate(outputDate);
  const keys = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const current = new Date(end);
    current.setUTCDate(end.getUTCDate() - offset);
    keys.push(dateKey(current));
  }
  return keys;
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
  return [cmd, ...args].join(" ");
}

function run(cmd, args = [], { cwd = process.cwd(), timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ ok: false, code: null, stdout, stderr, error: error.message, command: commandText(cmd, args) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        ok: code === 0 && signal !== "SIGTERM",
        code,
        stdout,
        stderr,
        error: signal === "SIGTERM" ? `Timed out after ${timeoutMs}ms` : null,
        command: commandText(cmd, args),
      });
    });
  });
}

async function readIfExists(filePath) {
  return existsSync(filePath) ? readFile(filePath, "utf8") : null;
}

async function collectMarkdownFiles(dir, root = dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdownFiles(fullPath, root));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.relative(root, fullPath));
  }
  return files;
}

async function findLatestOrgSyncReport(options) {
  if (options.orgSyncReport) return options.orgSyncReport;
  const reportsDir = path.join(options.orgRoot, "org-sync-reports");
  if (existsSync(reportsDir)) {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const reportPath = path.join(reportsDir, entry.name, "report.md");
      if (!existsSync(reportPath)) continue;
      const s = await stat(reportPath);
      candidates.push({ reportPath, mtimeMs: s.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates[0]) return candidates[0].reportPath;
  }

  const notesDir = path.join(options.orgRoot, "org-sync-notes");
  const notes = await collectMarkdownFiles(notesDir, notesDir);
  const daily = notes.filter((file) => /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort().reverse();
  if (daily[0]) return path.join(notesDir, daily[0]);
  return null;
}

async function findFounderSignalsForReport(orgSyncReportPath) {
  if (!orgSyncReportPath) return { path: null, content: null };
  const directPath = path.join(path.dirname(orgSyncReportPath), "founder-signals.json");
  if (existsSync(directPath)) return { path: directPath, content: await readFile(directPath, "utf8") };
  const reportContent = await readIfExists(orgSyncReportPath);
  const rawReport = reportContent?.match(/^raw_report:\s*["']?([^"'\n]+)["']?/m)?.[1];
  if (rawReport) {
    const siblingPath = path.join(path.dirname(rawReport), "founder-signals.json");
    if (existsSync(siblingPath)) return { path: siblingPath, content: await readFile(siblingPath, "utf8") };
  }
  return { path: directPath, content: null };
}

function questionsTemplate() {
  return `# Founder Questions

Ask these on every founder-sync review.

## Product

- How do current code changes impact our product roadmap?
- Which workflows became stronger?
- Which workflows became more complex?
- Which feature promises are now closer to launch?
- Which product risks increased?

## Sales / GTM

- What extra sales/GTM strategy can be done based on this week’s product changes?
- Which changes create a new sales story?
- Which changes help demos?
- Which changes reduce objections?
- Which changes should not be sold yet?

## Marketing

- What content can be created from this week’s progress?
- Which product narratives became stronger?
- What proof points are now available?
- What should be posted on LinkedIn / website / investor updates?

## Founder Reflection

- What did we learn this week?
- What customer feedback did we receive?
- Which sales/marketing actions were taken?
- What worked?
- What did not work?
- What are the biggest hurdles?

## Next Actions

- What should be done next by product?
- What should be done next by engineering?
- What should be done next by sales?
- What should be done next by marketing?
- What needs research before deciding?
`;
}

function founderInputTemplate() {
  return `# Founder Input

Fill this before running \`founder-sync\`.

## What did I learn since the last sync?

- 

## What sales conversations happened?

- 

## What customer/user feedback did I receive?

- 

## What marketing/GTM steps did I take?

- 

## What worked?

- 

## What did not work?

- 

## What hurdles/blockers appeared?

- 

## Any intuition or founder judgment I want the system to consider?

- 
`;
}

function goalsTemplate() {
  return `# Founder Goals

Use this as the benchmark file for every \`founder-sync\` run. The sync should judge product, engineering, sales, marketing, GTM, and research against these goals.

## North Star

- Target users: 10,000
- Target paid customers: 2,000
- Target revenue:
- Target launch market:
- Target date:

## Example Benchmarks

- [ ] Reach 10,000 users
- [ ] Reach 2,000 paid customers

## Product Goals

- 

## Sales / GTM Goals

- 

## Marketing Goals

- 

## Operational Goals

- 

## Constraints / Non-Goals

- 
`;
}

function gtmExperimentsTemplate() {
  return `# GTM Experiments

Use this as the running ledger for active, completed, paused, and proposed GTM tests.

<!-- founder-sync:generated:start -->
# GTM Experiments

Last updated: never

## Active

## Proposed

## Completed / Learned

## Paused / Rejected With Rationale
<!-- founder-sync:generated:end -->
`;
}

async function ensureFounderInputs(options) {
  const requiredMissing = [];
  let gtmExperimentsCreated = false;
  const goalsPath = path.join(options.visionDir, "goals.md");
  const gtmExperimentsPath = path.join(options.visionDir, "gtm-experiments.md");
  if (!existsSync(goalsPath)) requiredMissing.push({ path: goalsPath, content: goalsTemplate() });
  if (!existsSync(gtmExperimentsPath)) {
    gtmExperimentsCreated = true;
    if (!options.dryRun) {
      await mkdir(options.visionDir, { recursive: true });
      await writeFile(gtmExperimentsPath, gtmExperimentsTemplate(), "utf8");
    }
  }
  if (!existsSync(options.questionsPath)) requiredMissing.push({ path: options.questionsPath, content: questionsTemplate() });
  const founderInputPath = path.join(options.visionDir, "founder-input.md");
  if (!existsSync(founderInputPath)) requiredMissing.push({ path: founderInputPath, content: founderInputTemplate() });
  if (requiredMissing.length && !options.dryRun) {
    await mkdir(options.visionDir, { recursive: true });
    for (const item of requiredMissing) await writeFile(item.path, item.content, "utf8");
  }
  return { requiredMissing, gtmExperimentsCreated, founderInputPath, goalsPath, gtmExperimentsPath };
}

function truncateForContinuity(content) {
  const buffer = Buffer.from(content);
  if (buffer.length <= MAX_CONTINUITY_FILE_BYTES) return content;
  return `${buffer.subarray(0, MAX_CONTINUITY_FILE_BYTES).toString("utf8")}\n\n[truncated for continuity context]\n`;
}

async function readContinuityFile(filePath, label) {
  const content = await readIfExists(filePath);
  if (!content) return null;
  return `\n\n### ${label}\n\n${truncateForContinuity(content)}`;
}

async function readDatedVisionFiles(options, section) {
  const chunks = [];
  for (const key of continuityDateKeys(options.outputDate)) {
    const { year, month, yyyyMmDd } = dateParts(key);
    const relativePath = path.join("vision", section, year, month, `${yyyyMmDd}.md`);
    const fullPath = path.join(options.orgRoot, relativePath);
    const chunk = await readContinuityFile(fullPath, relativePath);
    if (chunk) chunks.push(chunk);
  }
  return chunks.join("\n");
}

async function loadContinuityContext(options, goalsPath) {
  const todosPath = path.join(options.visionDir, "todos.md");
  const [goals, todos, dailyNotes, decisionNotes, researchNotes] = await Promise.all([
    readIfExists(goalsPath),
    readIfExists(todosPath),
    readDatedVisionFiles(options, "daily"),
    readDatedVisionFiles(options, "decisions"),
    readDatedVisionFiles(options, "research"),
  ]);
  return {
    goals: goals ? truncateForContinuity(goals) : null,
    todos: todos ? truncateForContinuity(todos) : null,
    dailyNotes,
    decisionNotes,
    researchNotes,
  };
}

async function loadAgencyAgents(options) {
  const categories = ["product", "sales", "marketing", "engineering", "strategy"];
  let usedBytes = 0;
  const sections = [];
  const counts = new Map();

  for (const category of categories) {
    const categoryDir = path.join(options.agentsRoot, category);
    const files = await collectMarkdownFiles(categoryDir, categoryDir);
    counts.set(category, files.length);
    for (const file of files.sort()) {
      const fullPath = path.join(categoryDir, file);
      const content = await readFile(fullPath, "utf8");
      const header = `\n\n## Agency Agent: ${category}/${file}\n\n`;
      const remaining = options.maxAgentBytes - usedBytes - Buffer.byteLength(header);
      if (remaining <= 0) break;
      const chunk = Buffer.from(content).subarray(0, remaining).toString("utf8");
      usedBytes += Buffer.byteLength(header) + Buffer.byteLength(chunk);
      sections.push(`${header}${chunk}${chunk.length < content.length ? "\n\n[truncated]\n" : ""}`);
    }
  }

  return { markdown: sections.join("\n"), counts, usedBytes };
}

function buildPrompt({ options, orgSyncReportPath, orgSyncReport, founderSignalsPath, founderSignals, questions, founderInput, agency, continuity, gtmExperiments }) {
  const researchContract = options.research
    ? `\n<!-- founder-sync:research -->\n# Founder Research - ${options.outputDate}\n\n## Research Brief\n\n## Market / Customer Questions\n\n## Product Questions\n\n## Sales / GTM Questions\n\n## Engineering / Execution Questions\n\n## Suggested Follow-Ups\n<!-- /founder-sync:research -->\n`
    : "";
  return `# Founder Sync Prompt

You are my co-founder, strategist, and operating partner.

Do not merely summarize engineering changes. Use the org-sync report, founder goals, previous 7 days of learnings, current todos, founder questions, founder input, and agency-agent perspectives to decide what matters for product, sales, marketing, GTM, research, and next execution.

Reconcile the last ${CONTINUITY_DAYS} days of learnings, decisions, research, goals, and current todos. Needs and todos must continue to propagate until they are achieved, explicitly deprioritized, or replaced with rationale.

Be opinionated. Challenge weak assumptions. Separate evidence from speculation. If the founder input is sparse, say what is missing and ask for it.

## Run Context

- Org root: ${options.orgRoot}
- Date: ${options.outputDate}
- Research mode: ${options.research ? "yes" : "no"}
- Org sync report: ${orgSyncReportPath}

## Required Output Contract

Return exactly these delimiter blocks. Do not wrap them in code fences.

## Todo Carry-Forward Rules

- Include unfinished todos from the existing todos.md unless they are achieved, explicitly deprioritized, or replaced.
- If a todo is removed or deprioritized, state the rationale in the daily or decisions output.
- Output todos must contain both carried-forward unfinished work and new todos from this run.
- Preserve checkboxes for actionable items.
- Do not silently drop unresolved needs, blockers, research questions, or GTM tasks from the last ${CONTINUITY_DAYS} days.

## GTM Channel Checklist

Evaluate whether any action is needed for each channel. Do not force todos for every channel, but explicitly consider all of them against the goals/benchmarks:

- referrals
- outbound
- founder-led sales
- field sales
- channel partners
- partnerships
- affiliates / resellers
- customer success / expansion
- SEO
- content marketing
- LinkedIn
- WhatsApp/community
- events
- marketplaces
- paid ads
- PR
- influencer / creator partnerships
- product-led loops
- app stores
- demos / webinars
- review sites / directories
- local associations and trade groups
- investor/advisor introductions

<!-- founder-sync:daily -->
# Founder Sync - ${options.outputDate}

## Executive Read

## What Changed

## Goal Impact

For each relevant goal from vision/goals.md:
- Goal:
- Impact:
- Evidence:
- Confidence:
- Next action:

## Product Impact

## Sales / GTM Impact

## Marketing Angles

## Engineering / Execution Risks

## Hurdles / Blockers

## Recommended Moves

## Questions For Founder
<!-- /founder-sync:daily -->

${researchContract}
<!-- founder-sync:decisions -->
# Founder Decisions - ${options.outputDate}

## Decisions To Make Today

## Recommended Decisions

## Deferred Decisions

## Risks If Unresolved
<!-- /founder-sync:decisions -->

<!-- founder-sync:todos -->
# Founder Todos

Last updated: ${options.outputDate}

## Carried Forward

## Critical This Week

## Product

## Sales

## Marketing

## GTM Channel Experiments

## Engineering

## Research

## Hurdles

## Deprioritized / Dropped With Rationale
<!-- /founder-sync:todos -->

<!-- founder-sync:gtm-experiments -->
# GTM Experiments

Last updated: ${options.outputDate}

## Active

## Proposed

## Completed / Learned

## Paused / Rejected With Rationale
<!-- /founder-sync:gtm-experiments -->

## Continuity Context

### Goals / Benchmarks

${continuity.goals || "No goals.md found."}

### Current Todos

${continuity.todos || "No existing todos.md found."}

### Previous 7 Days - Daily Notes

${continuity.dailyNotes || "No previous daily notes found."}

### Previous 7 Days - Decisions

${continuity.decisionNotes || "No previous decision notes found."}

### Previous 7 Days - Research

${continuity.researchNotes || "No previous research notes found."}

## Founder Signals

- Path: ${founderSignalsPath || "not found"}

\`\`\`json
${founderSignals || "{}"}
\`\`\`

## Existing GTM Experiment Ledger

${gtmExperiments || "No existing gtm-experiments.md found."}

## Founder Questions

${questions}

## Founder Input

${founderInput}

## Latest Org Sync Report

${orgSyncReport}

## Agency Agent Context

${agency.markdown}
`;
}

function extractBlock(text, name) {
  const regex = new RegExp(`<!--\\s*founder-sync:${name}\\s*-->([\\s\\S]*?)<!--\\s*\\/founder-sync:${name}\\s*-->`, "i");
  return text.match(regex)?.[1]?.trim() || null;
}

function fallbackDaily(options, orgSyncReportPath) {
  return `# Founder Sync - ${options.outputDate}

## Executive Read

LLM was skipped or failed. Review the source report manually.

## Goal Impact

- Goal: Review vision/goals.md manually.
- Impact: Unknown in no-LLM fallback.
- Evidence: ${orgSyncReportPath}
- Confidence: low
- Next action: Rerun founder-sync with LLM enabled or inspect founder-signals.json.

## Source Report

${orgSyncReportPath}

## Questions For Founder

- What did we learn from customers/sales since the last sync?
- Which product changes are demo-ready?
- Which changes are risky and should not be sold yet?
`;
}

function fallbackDecisions(options) {
  return `# Founder Decisions - ${options.outputDate}

## Decisions To Make Today

- Review latest org-sync report and choose top 3 priorities.

## Recommended Decisions

- Fill founder-input.md with recent sales/customer learnings and rerun founder-sync.

## Deferred Decisions

- Market/GTM decisions pending founder input.
`;
}

function fallbackResearch(options) {
  return `# Founder Research - ${options.outputDate}

## Research Brief

LLM was skipped or failed. Add research questions here and rerun with LLM enabled.
`;
}

function extractUncheckedItems(text) {
  if (!text) return [];
  const items = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^- \[ \] /.test(trimmed)) {
      items.push(trimmed);
    }
  }
  return items;
}

function normalizeItemText(item) {
  return item.replace(/^- \[ \] /, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function enforceContinuityTodos(generatedTodos, priorTodosText) {
  const uncheckedItems = extractUncheckedItems(priorTodosText);
  if (!uncheckedItems.length) return generatedTodos;

  const genLower = generatedTodos.toLowerCase();
  const missing = [];
  for (const item of uncheckedItems) {
    const normalized = normalizeItemText(item);
    if (!genLower.includes(normalized)) {
      missing.push(item);
    }
  }

  if (!missing.length) return generatedTodos;

  const appendix = "\n\n## Carried Forward\n\n" + missing.join("\n") + "\n";
  return generatedTodos.trimEnd() + appendix;
}

function carryForwardTodosText(continuity) {
  if (!continuity?.todos) return "- [ ] Review existing unfinished todos and keep carrying them forward until achieved or explicitly deprioritized.";
  const todosContent = continuity.todos
    .replace(/<!--\s*founder-sync:generated:start\s*-->/gi, "")
    .replace(/<!--\s*founder-sync:generated:end\s*-->/gi, "");
  const uncheckedItems = extractUncheckedItems(todosContent);
  if (!uncheckedItems.length) return "- [ ] Review existing unfinished todos and keep carrying them forward until achieved or explicitly deprioritized.";
  return uncheckedItems.join("\n");
}

function fallbackTodos(options, continuity) {
  return `# Founder Todos

Last updated: ${options.outputDate}

## Carried Forward

${carryForwardTodosText(continuity)}

## Critical This Week

- [ ] Fill vision/founder-input.md with sales, marketing, customer feedback, and hurdles.
- [ ] Fill vision/goals.md with measurable benchmarks such as 10,000 users and 2,000 paid customers.
- [ ] Review latest org-sync report for high-risk engineering changes.
- [ ] Rerun founder-sync with LLM enabled for strategic synthesis.

## GTM Channel Experiments

- [ ] Pick the highest-leverage GTM channels to test next across referrals, outbound, partnerships, SEO, content, LinkedIn, WhatsApp/community, events, ads, PR, product-led loops, field sales, channel partners, affiliates/resellers, and founder-led sales.

## Deprioritized / Dropped With Rationale
`;
}

function fallbackGtmExperiments(options) {
  return `# GTM Experiments

Last updated: ${options.outputDate}

## Active

- [ ] Review current channels and decide which GTM experiments are active.

## Proposed

- [ ] Pick one experiment linked to the 10,000 users goal.
- [ ] Pick one experiment linked to the 2,000 paid customers goal.

## Completed / Learned

## Paused / Rejected With Rationale
`;
}

function updateGeneratedSection(existing, generated) {
  const start = "<!-- founder-sync:generated:start -->";
  const end = "<!-- founder-sync:generated:end -->";
  const block = `${start}\n${generated.trim()}\n${end}`;
  if (!existing) return `${block}\n`;
  const regex = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (regex.test(existing)) return existing.replace(regex, block);
  return `${existing.trim()}\n\n${block}\n`;
}

async function writeVisionOutputs(options, blocks, orgSyncReportPath, continuity, gtmExperimentsPath) {
  const { year, month, yyyyMmDd } = dateParts(options.outputDate);
  const dailyDir = path.join(options.visionDir, "daily", year, month);
  const decisionsDir = path.join(options.visionDir, "decisions", year, month);
  const researchDir = path.join(options.visionDir, "research", year, month);
  await mkdir(dailyDir, { recursive: true });
  await mkdir(decisionsDir, { recursive: true });
  if (options.research) await mkdir(researchDir, { recursive: true });

  const daily = blocks.daily || fallbackDaily(options, orgSyncReportPath);
  const decisions = blocks.decisions || fallbackDecisions(options);
  const todos = blocks.todos || fallbackTodos(options, continuity);
  const dailyPath = path.join(dailyDir, `${yyyyMmDd}.md`);
  const decisionsPath = path.join(decisionsDir, `${yyyyMmDd}.md`);
  const todosPath = path.join(options.visionDir, "todos.md");

  await writeFile(dailyPath, daily.endsWith("\n") ? daily : `${daily}\n`, "utf8");
  await writeFile(decisionsPath, decisions.endsWith("\n") ? decisions : `${decisions}\n`, "utf8");
  const existingTodos = await readIfExists(todosPath);
  await writeFile(todosPath, updateGeneratedSection(existingTodos, todos), "utf8");
  const existingGtmExperiments = await readIfExists(gtmExperimentsPath);
  if (blocks.gtmExperiments) {
    await writeFile(gtmExperimentsPath, updateGeneratedSection(existingGtmExperiments, blocks.gtmExperiments), "utf8");
  } else {
    const hasGeneratedSection = existingGtmExperiments && /<!--\s*founder-sync:generated:start\s*-->/.test(existingGtmExperiments);
    if (!hasGeneratedSection) {
      const fallback = fallbackGtmExperiments(options);
      await writeFile(gtmExperimentsPath, updateGeneratedSection(existingGtmExperiments, fallback), "utf8");
    }
  }

  let researchPath = null;
  if (options.research) {
    const research = blocks.research || fallbackResearch(options);
    researchPath = path.join(researchDir, `${yyyyMmDd}.md`);
    await writeFile(researchPath, research.endsWith("\n") ? research : `${research}\n`, "utf8");
  }

  return { dailyPath, decisionsPath, researchPath, todosPath, gtmExperimentsPath };
}

async function assertVisionMarkdownOnly(visionDir) {
  if (!existsSync(visionDir)) return;
  const entries = await readdir(visionDir, { withFileTypes: true });
  const bad = [];
  async function walk(dir) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile() && !item.name.endsWith(".md")) bad.push(path.relative(visionDir, full));
    }
  }
  for (const entry of entries) {
    const full = path.join(visionDir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && !entry.name.endsWith(".md")) bad.push(entry.name);
  }
  if (bad.length) console.warn(`Warning: vision contains non-Markdown files: ${bad.join(", ")}`);
}

async function invokeOpenCode(promptPath, responsePath, options) {
  const parts = shellWords(options.opencodeCmd);
  if (!parts.length) return { ok: false, error: "Empty --opencode-cmd" };
  const cmd = parts[0];
  const args = [...parts.slice(1), "Read the attached founder-sync prompt and produce the requested Markdown outputs exactly.", "--file", promptPath];
  const result = await run(cmd, args, { cwd: options.orgRoot });
  await writeFile(responsePath, result.stdout || result.stderr || result.error || "", "utf8");
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const orgStats = await stat(options.orgRoot).catch(() => null);
  if (!orgStats?.isDirectory()) throw new Error(`Org root does not exist: ${options.orgRoot}`);

  const orgSyncReportPath = await findLatestOrgSyncReport(options);
  const { requiredMissing, gtmExperimentsCreated, founderInputPath, goalsPath, gtmExperimentsPath } = await ensureFounderInputs(options);
  const founderSignals = await findFounderSignalsForReport(orgSyncReportPath);
  let agentStats = existsSync(options.agentsRoot) ? await loadAgencyAgents(options) : null;

  console.log(`Org root: ${options.orgRoot}`);
  console.log(`Org sync report: ${orgSyncReportPath || "missing"}`);
  console.log(`Questions: ${options.questionsPath}`);
  console.log(`Goals: ${goalsPath}`);
  console.log(`GTM experiments: ${gtmExperimentsPath}`);
  console.log(`Founder input: ${founderInputPath}`);
  console.log(`Founder signals: ${founderSignals.content ? founderSignals.path : "missing"}`);
  console.log(`Agents root: ${options.agentsRoot}`);
  console.log(`Vision: ${options.visionDir}`);
  console.log(`Run dir: ${options.runDir}`);
  console.log(`OpenCode: ${options.llm ? "yes" : "no"}`);
  console.log(`Research: ${options.research ? "yes" : "no"}`);

  if (agentStats) {
    console.log(`Agency agent files: ${Array.from(agentStats.counts.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  if (gtmExperimentsCreated) {
    console.log(`GTM experiments template created: ${gtmExperimentsPath}`);
  }

  if (requiredMissing.length) {
    console.log("First-run: created founder input template files (fill these for better results):");
    for (const item of requiredMissing) console.log(`- ${item.path}${options.dryRun ? " (would create)" : " (created)"}`);
    console.log("Continuing with template defaults. Update vision/ files and rerun for richer output.");
    // Do NOT return — proceed so the first run still produces useful output.
  }

  if (!orgSyncReportPath) throw new Error("No org-sync report found. Run org-sync first or pass --org-sync-report.");
  if (!agentStats) {
    console.warn(`Agency agents root not found: ${options.agentsRoot}. Proceeding with empty agency context.`);
    agentStats = { markdown: "", counts: new Map(), usedBytes: 0 };
  }

  const { year, month, yyyyMmDd } = dateParts(options.outputDate);
  const planned = {
    daily: path.join(options.visionDir, "daily", year, month, `${yyyyMmDd}.md`),
    decisions: path.join(options.visionDir, "decisions", year, month, `${yyyyMmDd}.md`),
    research: options.research ? path.join(options.visionDir, "research", year, month, `${yyyyMmDd}.md`) : null,
    todos: path.join(options.visionDir, "todos.md"),
    gtmExperiments: gtmExperimentsPath,
  };

  if (options.dryRun) {
    console.log("Dry run only. Planned outputs:");
    Object.entries(planned).forEach(([key, value]) => { if (value) console.log(`- ${key}: ${value}`); });
    return;
  }

  const [orgSyncReport, questions, founderInput, continuity, gtmExperiments] = await Promise.all([
    readFile(orgSyncReportPath, "utf8"),
    readFile(options.questionsPath, "utf8"),
    readFile(founderInputPath, "utf8"),
    loadContinuityContext(options, goalsPath),
    readIfExists(gtmExperimentsPath),
  ]);

  await mkdir(options.runDir, { recursive: true });
  const prompt = buildPrompt({ options, orgSyncReportPath, orgSyncReport, founderSignalsPath: founderSignals.path, founderSignals: founderSignals.content, questions, founderInput, agency: agentStats, continuity, gtmExperiments });
  const promptPath = path.join(options.runDir, "prompt.md");
  const responsePath = path.join(options.runDir, "response.md");
  await writeFile(promptPath, prompt, "utf8");

  let response = "";
  if (options.llm) {
    console.warn("OpenCode may send prompt content according to your configured provider. Use --no-llm for local-only output.");
    const result = await invokeOpenCode(promptPath, responsePath, options);
    if (!result.ok) console.warn(`OpenCode failed: ${result.stderr || result.error}`);
    response = await readFile(responsePath, "utf8");
  } else {
    response = "";
    await writeFile(path.join(options.runDir, "fallback.md"), "LLM skipped. Fallback vision outputs were generated.\n", "utf8");
  }

  const blocks = {
    daily: extractBlock(response, "daily"),
    decisions: extractBlock(response, "decisions"),
    todos: extractBlock(response, "todos"),
    gtmExperiments: extractBlock(response, "gtm-experiments"),
    research: options.research ? extractBlock(response, "research") : null,
  };

  if (blocks.todos && continuity.todos) {
    blocks.todos = enforceContinuityTodos(blocks.todos, continuity.todos);
  }

  const outputs = await writeVisionOutputs(options, blocks, orgSyncReportPath, continuity, gtmExperimentsPath);
  await assertVisionMarkdownOnly(options.visionDir);

  const summary = `# Founder Sync Run Summary\n\n- Date: ${options.outputDate}\n- Org sync report: ${orgSyncReportPath}\n- Founder signals: ${founderSignals.content ? founderSignals.path : "not found"}\n- Prompt: ${promptPath}\n- Response: ${options.llm ? responsePath : "LLM skipped"}\n- Daily: ${outputs.dailyPath}\n- Decisions: ${outputs.decisionsPath}\n- Research: ${outputs.researchPath || "not requested"}\n- Todos: ${outputs.todosPath}\n- GTM experiments: ${outputs.gtmExperimentsPath}\n`;
  await writeFile(path.join(options.runDir, "run-summary.md"), summary, "utf8");

  console.log("Founder sync complete:");
  console.log(`- Daily: ${outputs.dailyPath}`);
  console.log(`- Decisions: ${outputs.decisionsPath}`);
  if (outputs.researchPath) console.log(`- Research: ${outputs.researchPath}`);
  console.log(`- Todos: ${outputs.todosPath}`);
  console.log(`- GTM experiments: ${outputs.gtmExperimentsPath}`);
}

main().catch((error) => {
  console.error(`founder-sync failed: ${error.message}`);
  process.exitCode = 1;
});
