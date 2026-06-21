#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectsRoot } from "./lib/org-config.mjs";

const DEFAULT_PORT = 3877;

function parseArgs(argv) {
  const options = { projectsRoot: resolveProjectsRoot(null), port: DEFAULT_PORT, allRuns: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--projects-root":
        options.projectsRoot = path.resolve(next());
        break;
      case "--port":
        options.port = Number.parseInt(next(), 10);
        break;
      case "--all-runs":
        options.allRuns = true;
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

function usage() {
  return `org-dashboard: read-only local dashboard for *_org intelligence.

Usage:
  org-dashboard
  org-dashboard --port 3877

Options:
  --projects-root <path>   Folder containing *_org folders. Default: cwd (or ORG_SYNC_PROJECTS_ROOT env).
  --port <n>               Localhost port. Default: ${DEFAULT_PORT}.
  --help                   Show this help.
`;
}

async function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readTextPreview(filePath, maxChars = 1800) {
  if (!filePath || !existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf8");
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n*[…truncated — open full file for more]*";
}

async function readLatestFounderDaily(orgPath) {
  const dailyRoot = path.join(orgPath, "vision", "daily");
  if (!existsSync(dailyRoot)) return null;
  const years = (await readdir(dailyRoot, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name)).map((e) => e.name).sort().reverse();
  for (const year of years) {
    const months = (await readdir(path.join(dailyRoot, year), { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name)).map((e) => e.name).sort().reverse();
    for (const month of months) {
      const files = (await readdir(path.join(dailyRoot, year, month), { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)).map((e) => e.name).sort().reverse();
      if (files[0]) return path.join(dailyRoot, year, month, files[0]);
    }
  }
  return null;
}

function extractMarkdownSection(content, sectionHeading, maxChars = 600) {
  if (!content) return null;
  const headingRe = new RegExp(`^#{1,4}\\s+${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi");
  const match = content.match(headingRe);
  if (!match) return null;
  const start = match.index + match[0].length;
  const tail = content.slice(start);
  const nextHeadingIdx = tail.search(/^#{1,4}\s/m);
  const section = (nextHeadingIdx > 0 ? tail.slice(0, nextHeadingIdx) : tail).trim();
  if (!section) return null;
  return section.length <= maxChars ? section : section.slice(0, maxChars) + "…";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "heading";
}

function allowedHref(href) {
  if (!href) return false;
  if (href.startsWith("//")) return false;
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) return true;
  if (href.startsWith("/")) return true;
  return false;
}

function buildProductCapabilityMap(repos) {
  const flowMap = {};
  for (const repo of repos) {
    for (const flow of repo.productFlows || []) {
      if (!flowMap[flow.id]) flowMap[flow.id] = { ...flow, repos: [], riskTags: new Map() };
      flowMap[flow.id].repos.push(repo.name);
      for (const risk of repo.riskTags || []) {
        const existing = flowMap[flow.id].riskTags.get(risk.id);
        if (existing) {
          existing.repos.push(repo.name);
        } else {
          flowMap[flow.id].riskTags.set(risk.id, { ...risk, repos: [repo.name] });
        }
      }
    }
  }
  return Object.values(flowMap).map((entry) => {
    const risks = [...entry.riskTags.values()].sort((a, b) => b.repos.length - a.repos.length);
    return { ...entry, riskTags: risks };
  }).sort((a, b) => b.repos.length - a.repos.length);
}

function flowSeverityPill(severity) {
  if (severity === "critical") return "bad";
  if (severity === "high") return "warn";
  return "ok";
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => {
    const href = u.trim();
    if (allowedHref(href)) return `<a href="${escapeHtml(href)}">${t}</a>`;
    return t;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s;
}

function safeMarkdownToHtml(md) {
  const raw = String(md ?? "");
  const lines = raw.split("\n");
  const blocks = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const codeMatch = line.match(/^(```|~~~)(\w*)$/);
    if (codeMatch) {
      const fence = codeMatch[1];
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", content: codeLines.join("\n") });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text);
      toc.push({ level, text, id });
      blocks.push({ type: "heading", level, text, id });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ulist", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "olist", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|```|~~~|[-*+]\s|\d+\.\s)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "para", content: paraLines.join("\n") });
    }
  }

  let html = "";
  for (const b of blocks) {
    switch (b.type) {
      case "code":
        html += `<pre><code>${escapeHtml(b.content)}</code></pre>\n`;
        break;
      case "heading":
        html += `<h${b.level} id="${escapeHtml(b.id)}">${renderInline(b.text)}</h${b.level}>\n`;
        break;
      case "hr":
        html += `<hr>\n`;
        break;
      case "ulist":
        html += `<ul>\n${b.items.map((item) => `  <li>${renderInline(item)}</li>`).join("\n")}\n</ul>\n`;
        break;
      case "olist":
        html += `<ol>\n${b.items.map((item) => `  <li>${renderInline(item)}</li>`).join("\n")}\n</ol>\n`;
        break;
      case "para":
        html += `<p>${renderInline(b.content)}</p>\n`;
        break;
    }
  }

  const tocHtml =
    toc.length > 0
      ? `<nav class="toc"><h2>Contents</h2>${toc
          .map((h) => `<a href="#${escapeHtml(h.id)}" class="toc-h${h.level}">${escapeHtml(h.text)}</a>`)
          .join("\n")}</nav>\n`
      : "";

  return tocHtml + html;
}

function renderJsonContent(content) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    return `<pre>${escapeHtml(content)}</pre>`;
  }
  return `<pre class="json">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{--bg:#0b1120;--surface:#111827;--border:#1e2d42;--border2:#263244;--text:#e2e8f0;--muted:#94a3b8;--link:#7dd3fc;--link-hover:#bae6fd;--green:#166534;--green-bg:#14532d;--red-bg:#7f1d1d;--amber-bg:#78350f;--blue-bg:#1e3a5f;--purple-bg:#3b0764}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--text);line-height:1.65;font-size:15px}
a{color:var(--link);text-decoration:none}a:hover{color:var(--link-hover);text-decoration:underline}
.wrap{max-width:1160px;margin:0 auto;padding:20px 24px}
.topnav{background:#0d1526;border-bottom:1px solid var(--border);padding:10px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.topnav a{color:var(--muted);font-size:.9em;font-weight:500;padding:4px 10px;border-radius:6px}
.topnav a:hover{color:var(--text);background:var(--surface)}
.topnav .logo{color:var(--text);font-weight:700;font-size:1em;margin-right:8px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin:12px 0}
.card-sm{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.muted{color:var(--muted);font-size:.9em}
.label{font-size:.75em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.num{font-size:2em;font-weight:700;line-height:1;color:var(--text);margin:.1em 0}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;background:#1f2937;margin:2px;font-size:.82em;font-weight:500;border:1px solid #263244}
.bad{background:var(--red-bg);border-color:#991b1b;color:#fca5a5}
.ok{background:var(--green-bg);border-color:#15803d;color:#86efac}
.warn{background:var(--amber-bg);border-color:#b45309;color:#fcd34d}
.sel{background:var(--blue-bg);border-color:#1d4ed8;color:#93c5fd}
.info{background:var(--purple-bg);border-color:#7e22ce;color:#d8b4fe}
pre{white-space:pre-wrap;background:#020617;padding:14px;border-radius:10px;overflow:auto;font-size:.85em;border:1px solid var(--border)}
h1{font-size:1.7em;font-weight:700;margin:.2em 0 .5em;color:#f1f5f9}
h2{font-size:1.2em;font-weight:600;margin:.8em 0 .4em;color:#e2e8f0}
h3{font-size:1em;font-weight:600;margin:.6em 0 .3em;color:#cbd5e1}
small{color:var(--muted);font-size:.82em}
.section-title{font-size:.78em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:1.4em 0 .5em;padding-bottom:.3em;border-bottom:1px solid var(--border)}
.digest{background:#0d1f35;border:1px solid #1e3a5f;border-radius:14px;padding:20px 22px;margin:12px 0}
.digest-label{font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7dd3fc;margin-bottom:.5em}
.brief-card{background:#131f30;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin:8px 0}
.brief-domain{font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.3em}
.signal-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.signal-row:last-child{border-bottom:none}
.signal-num{font-size:1.4em;font-weight:700;min-width:2.5em;text-align:right}
.signal-label{color:var(--text);font-size:.92em}
details>summary{cursor:pointer;padding:8px 2px;font-weight:600;color:#cbd5e1;list-style:none;user-select:none}
details>summary::before{content:"▶ ";font-size:.75em;color:var(--muted)}
details[open]>summary::before{content:"▼ "}
.markdown-body{max-width:900px}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.4em;line-height:1.3;color:#f1f5f9}
.markdown-body h1{border-bottom:1px solid #263244;padding-bottom:.3em}
.markdown-body h2{border-bottom:1px solid #1e293b;padding-bottom:.2em}
.markdown-body p{margin:.6em 0}
.markdown-body ul,.markdown-body ol{padding-left:1.6em;margin:.4em 0}
.markdown-body li{margin:.25em 0}
.markdown-body pre{background:#020617;padding:14px;border-radius:10px;overflow:auto;margin:.8em 0;border:1px solid #1e293b}
.markdown-body pre code{background:0 0;padding:0;font-size:.88em}
.markdown-body code{background:#1e293b;padding:2px 6px;border-radius:4px;font-size:.85em;color:#e2e8f0}
.markdown-body strong{color:#f1f5f9}
.markdown-body hr{border:none;border-top:1px solid #263244;margin:1.2em 0}
.markdown-body a{color:#93c5fd;text-decoration:underline}
.markdown-body blockquote{border-left:3px solid #334155;margin:.8em 0;padding:.2em 1em;color:#9ca3af}
.toc{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin:1em 0;max-width:880px}
.toc h2{margin:0 0 .5em;font-size:1.1em;color:#e5e7eb}
.toc a{display:block;padding:2px 0;color:#94a3b8;text-decoration:none;font-size:.9em}
.toc a:hover{color:#93c5fd}
.toc-h3{padding-left:1.2em!important}
.toc-h4{padding-left:2.4em!important}
pre.json{font-size:.82em}
</style></head><body>
<div class="topnav"><span class="logo">⚡ OrgIntel</span><a href="/">All Orgs</a><a href="/risks">Risk Signals</a><a href="/founder">Founder</a><a href="/gtm">GTM</a></div>
<div class="wrap">${body}</div></body></html>`;
}

function statusClass(status) {
  if (status === "completed" || status === "org-synced") return "ok";
  if (status === "planned" || status === "founder-input-required") return "warn";
  return "bad";
}

const PATH_TRAVERSAL = /[/\\]|\.\./;

function validateOrgName(orgName, index) {
  if (!orgName || PATH_TRAVERSAL.test(orgName)) return null;
  return (index.orgs || []).some((org) => org.name === orgName) ? orgName : null;
}

function validateRepoName(repoName) {
  if (!repoName || PATH_TRAVERSAL.test(repoName)) return null;
  return repoName;
}

function notFoundPage(title, body) {
  return page("Not found", `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/">Home</a></p>`);
}

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_MAIN_ARTIFACT_KINDS = {
  "report": "report.md",
  "run-summary": "run-summary.json",
  "founder-signals": "founder-signals.json",
  "org-prompt": "org-prompt.md",
  "deep-review-prompt": "deep-review-prompt.md",
  "release-review-prompt": "release-review-prompt.md",
  "agency-briefs/product": "agency-briefs/product.md",
  "agency-briefs/gtm": "agency-briefs/gtm.md",
  "agency-briefs/sales": "agency-briefs/sales.md",
  "agency-briefs/marketing": "agency-briefs/marketing.md",
  "agency-briefs/engineering": "agency-briefs/engineering.md",
  "agency-briefs/customer-success": "agency-briefs/customer-success.md",
  "agency-briefs/index": "agency-briefs/index.json",
};

const ALLOWED_ARTIFACT_KINDS = {
  "summary.json": "summary.json",
  "git-summary": "git-summary.md",
  "llm-prompt": "llm-prompt.md",
};

function parseRunDate(runId) {
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  const iso = `${runId.slice(0, 10)}T${runId.slice(11, 13)}:${runId.slice(14, 16)}:${runId.slice(17, 19)}.${runId.slice(20, 23)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function friendlyRunLabel(runId) {
  if (!runId || !RUN_ID_RE.test(runId)) return runId || "?";
  const year = runId.slice(0, 4);
  const monthIndex = Number.parseInt(runId.slice(5, 7), 10) - 1;
  const day = Number.parseInt(runId.slice(8, 10), 10);
  const hour = runId.slice(11, 13);
  const minute = runId.slice(14, 16);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (monthIndex >= 0 && monthIndex < months.length && day > 0) {
    return `${months[monthIndex]} ${day}, ${year} · ${hour}:${minute}`;
  }
  return `${runId.slice(0, 10)} ${hour}:${minute}`;
}

function localDateFromRunId(runId) {
  const d = parseRunDate(runId);
  if (!d) return runId.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ALLOWED_WEEKLY_ARTIFACT_KINDS = {
  "weekly-summary.md": "weekly-summary.md",
  "weekly-summary.json": "weekly-summary.json",
  "developer-summary.md": "developer-summary.md",
  "agency-briefs/product": "agency-briefs/product.md",
  "agency-briefs/gtm": "agency-briefs/gtm.md",
  "agency-briefs/sales": "agency-briefs/sales.md",
  "agency-briefs/marketing": "agency-briefs/marketing.md",
  "agency-briefs/engineering": "agency-briefs/engineering.md",
  "agency-briefs/customer-success": "agency-briefs/customer-success.md",
  "agency-briefs/index": "agency-briefs/index.json",
};

const VISION_STATIC_FILES = {
  "goals": "goals.md",
  "questions": "questions.md",
  "founder-input": "founder-input.md",
  "todos": "todos.md",
  "gtm-experiments": "gtm-experiments.md",
  "product-overview": "product-overview.md",
};

const VISION_LATEST_KINDS = new Set(["daily", "decisions", "research"]);

function safeWeeklyArtifactPath(orgPath, timestamp, kind) {
  if (!validateRunId(timestamp)) return null;
  const fileName = ALLOWED_WEEKLY_ARTIFACT_KINDS[kind];
  if (!fileName) return null;
  const resolved = path.resolve(orgPath, "org-sync-weekly", timestamp, fileName);
  const reportsDir = path.resolve(orgPath, "org-sync-weekly");
  if (!resolved.startsWith(reportsDir + path.sep)) return null;
  return resolved;
}

function countSafeContent(orgPath, runId) {
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

async function generatedAtTimeFromSummary(orgPath, runId) {
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

async function llmStatusFromSummary(orgPath, runId) {
  const summaryPath = path.join(orgPath, "org-sync-reports", runId, "run-summary.json");
  if (!existsSync(summaryPath)) return "unknown";
  try {
    const data = JSON.parse(await readFile(summaryPath, "utf8"));
    return data.llm?.status || "unknown";
  } catch {
    return "unknown";
  }
}

async function selectCanonicalRun(orgPath, runIds) {
  if (runIds.length === 0) return null;
  if (runIds.length === 1) return runIds[0];
  const scored = await Promise.all(
    runIds.map(async (id) => {
      const llmStatus = await llmStatusFromSummary(orgPath, id);
      const genAt = await generatedAtTimeFromSummary(orgPath, id);
      const completeness = countSafeContent(orgPath, id);
      return { id, llmDone: llmStatus === "completed" ? 1 : 0, genAt, completeness };
    })
  );
  scored.sort((a, b) => {
    if (b.llmDone !== a.llmDone) return b.llmDone - a.llmDone;
    if (a.genAt && b.genAt) return b.genAt.localeCompare(a.genAt);
    if (a.genAt) return -1;
    if (b.genAt) return 1;
    if (b.completeness !== a.completeness) return b.completeness - a.completeness;
    return b.id.localeCompare(a.id);
  });
  return scored[0].id;
}

async function discoverCanonicalRuns(orgPath) {
  const rawRuns = (await discoverReportRuns(orgPath)).slice(0, 60);
  const byDate = {};
  for (const runId of rawRuns) {
    const dateKey = localDateFromRunId(runId);
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(runId);
  }
  const dateKeys = Object.keys(byDate).sort().reverse();
  const result = [];
  for (const dateKey of dateKeys) {
    const canonical = await selectCanonicalRun(orgPath, byDate[dateKey]);
    result.push({ date: dateKey, canonical, all: byDate[dateKey] });
  }
  return result;
}

function validateRunId(runId) {
  return runId && RUN_ID_RE.test(runId) ? runId : null;
}

async function discoverReportRuns(orgPath) {
  const reportsDir = path.join(orgPath, "org-sync-reports");
  if (!existsSync(reportsDir)) return [];
  const entries = await readdir(reportsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && validateRunId(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

function safeArtifactPath(reportRoot, repoName, kind) {
  const fileName = ALLOWED_ARTIFACT_KINDS[kind];
  if (!fileName) return null;
  const resolved = path.resolve(reportRoot, "repos", repoName, fileName);
  const relative = path.relative(reportRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function safeMainArtifactPath(reportRoot, kind) {
  const fileName = ALLOWED_MAIN_ARTIFACT_KINDS[kind];
  if (!fileName) return null;
  const resolved = path.resolve(reportRoot, fileName);
  const relative = path.relative(reportRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

async function safeVisionFilePath(orgPath, fileName) {
  if (!fileName || PATH_TRAVERSAL.test(fileName)) return null;
  try {
    const visionRoot = await realpath(path.join(orgPath, "vision"));
    const target = await realpath(path.join(visionRoot, fileName));
    if (target !== visionRoot && !target.startsWith(visionRoot + path.sep)) return null;
    return target;
  } catch {
    return null;
  }
}

async function latestVisionDatedFile(orgPath, kind) {
  if (!VISION_LATEST_KINDS.has(kind)) return null;
  const root = path.join(orgPath, "vision", kind);
  if (!existsSync(root)) return null;
  const years = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 3);
  for (const year of years) {
    const months = (await readdir(path.join(root, year), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 12);
    for (const month of months) {
      const files = (await readdir(path.join(root, year, month), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      if (files[0]) return path.join(kind, year, month, files[0]);
    }
  }
  return null;
}

async function safeVisionKindPath(orgPath, kind) {
  const staticFile = VISION_STATIC_FILES[kind];
  if (staticFile) return safeVisionFilePath(orgPath, staticFile);
  const latest = await latestVisionDatedFile(orgPath, kind);
  if (!latest) return null;
  try {
    const visionRoot = await realpath(path.join(orgPath, "vision"));
    const target = await realpath(path.join(visionRoot, latest));
    if (!target.startsWith(visionRoot + path.sep)) return null;
    return target;
  } catch {
    return null;
  }
}

async function latestWeeklyTimestamp(orgPath) {
  const weeklyDir = path.join(orgPath, "org-sync-weekly");
  if (!existsSync(weeklyDir)) return null;
  const entries = await readdir(weeklyDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && validateRunId(e.name)).map((e) => e.name).sort().reverse()[0] || null;
}

async function latestFounderSyncRun(orgPath) {
  const dir = path.join(orgPath, "founder-sync-runs");
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const runs = entries.filter((e) => e.isDirectory() && validateRunId(e.name)).map((e) => e.name).sort().reverse();
  return runs[0] || null;
}

async function loadRunSummary(orgPath, runId) {
  if (!runId) return null;
  return readJson(path.join(orgPath, "org-sync-reports", runId, "run-summary.json"), null).catch(() => null);
}

function llmStatusForRun(runSummary) {
  if (!runSummary) return { label: "unknown", cls: "warn", detail: "No run-summary.json found" };
  if (runSummary.options?.llm === true) return { label: "OpenCode on", cls: "ok", detail: runSummary.llm?.status || "enabled" };
  if (runSummary.options?.llm === false) return { label: "OpenCode off", cls: "warn", detail: "run used --no-llm or old local-only baseline" };
  return { label: "unknown", cls: "warn", detail: "old report format" };
}

function setupWarnings(org, latestRunSummary, founderPaths) {
  const warnings = [];
  if (!existsSync(path.join(org.path, "org-sync-reports"))) warnings.push("No org-sync reports yet.");
  if (!existsSync(path.join(org.path, "vision"))) warnings.push("No vision/ folder yet.");
  for (const [label, present] of Object.entries(founderPaths)) {
    if (!present) warnings.push(`Missing ${label}.`);
  }
  if (latestRunSummary?.options?.llm === false) warnings.push("Latest indexed run was local-only; rerun daily sync for OpenCode intelligence.");
  return warnings;
}

function sellRiskSignals(repos) {
  const highRisk = repos.filter((repo) => (repo.riskTags || []).some((risk) => risk.severity === "high"));
  const criticalFlows = repos.filter((repo) => (repo.productFlows || []).some((flow) => flow.severity === "critical"));
  const dirty = repos.filter((repo) => (repo.riskTags || []).some((risk) => risk.id === "dirty-worktree"));
  return [
    { label: "Demo-sensitive flows", count: criticalFlows.length, cls: criticalFlows.length ? "bad" : "ok", detail: "critical product flows touched" },
    { label: "Sales/GTM caution", count: highRisk.length, cls: highRisk.length ? "bad" : "ok", detail: "repos with high-risk tags" },
    { label: "Local hygiene", count: dirty.length, cls: dirty.length ? "warn" : "ok", detail: "repos with dirty worktrees in latest signals" },
  ];
}

async function validateRunExists(orgPath, runId) {
  if (!validateRunId(runId)) return null;
  const runs = await discoverReportRuns(orgPath);
  return runs.includes(runId) ? runId : null;
}

async function loadIndex(options) {
  return readJson(path.join(options.globalDir, "index.json"), { orgs: [], generatedAt: null });
}

async function renderHome(options) {
  const index = await loadIndex(options);

  const orgEntities = await Promise.all((index.orgs || []).map(async (o) => readJson(path.join(options.globalDir, "orgs", `${o.name}.json`), null)));

  let totalChanged = 0, totalCritical = 0, totalHighRisk = 0, deepNeeded = 0;
  const allFlows = [];
  for (const org of orgEntities) {
    if (!org) continue;
    const s = org.signals?.summary || {};
    totalChanged += s.reposWithChanges || 0;
    totalCritical += s.criticalFlowHits || 0;
    totalHighRisk += s.highRiskRepos || 0;
    if (s.deepReviewRecommended) deepNeeded++;
    for (const repo of org.signals?.repos || []) {
      for (const flow of repo.productFlows || []) allFlows.push({ org: org.name, ...flow });
    }
  }
  const flowCounts = {};
  for (const flow of allFlows) {
    if (!flowCounts[flow.id]) flowCounts[flow.id] = { label: flow.label, severity: flow.severity, count: 0 };
    flowCounts[flow.id].count++;
  }
  const topFlows = Object.values(flowCounts).sort((a, b) => b.count - a.count).slice(0, 8);

  const metricCards = `<div class="grid-3">
    <div class="card-sm"><div class="label">Projects Updated</div><div class="num">${totalChanged}</div></div>
    <div class="card-sm"><div class="label">Critical Flow Hits</div><div class="num" style="color:${totalCritical > 0 ? "#fca5a5" : "#86efac"}">${totalCritical}</div></div>
    <div class="card-sm"><div class="label">High-Risk Repos</div><div class="num" style="color:${totalHighRisk > 0 ? "#fcd34d" : "#86efac"}">${totalHighRisk}</div></div>
    <div class="card-sm"><div class="label">Deep Review Needed</div><div class="num" style="color:${deepNeeded > 0 ? "#fca5a5" : "#86efac"}">${deepNeeded}</div></div>
  </div>`;

  const flowChips = topFlows.length > 0
    ? `<div style="margin:.6em 0">${topFlows.map((f) => `<span class="pill ${flowSeverityPill(f.severity)}">${escapeHtml(f.label)}</span>`).join(" ")}</div>`
    : `<p class="muted">No product flows detected yet. Run org-sync-all first.</p>`;

  const orgCards = (index.orgs || []).map((org) => {
    const summary = org.summary || {};
    const hasChanges = (summary.reposWithChanges || 0) > 0;
    const hasCritical = (summary.criticalFlowHits || 0) > 0;
    const statusPill = `<span class="pill ${statusClass(org.status)}">${escapeHtml(org.status)}</span>`;
    return `<div class="card">
      <h2><a href="/orgs/${encodeURIComponent(org.name)}">${escapeHtml(org.name)}</a></h2>
      <p>${statusPill}${hasCritical ? ` <span class="pill bad">${summary.criticalFlowHits} critical</span>` : ""}</p>
      <div class="grid-3" style="margin:.5em 0">
        <div><div class="label">Changed</div><strong>${summary.reposWithChanges ?? "?"}</strong></div>
        <div><div class="label">Critical flows</div><strong style="color:${hasCritical ? "#fca5a5" : "inherit"}">${summary.criticalFlowHits ?? "?"}</strong></div>
        <div><div class="label">High-risk</div><strong>${summary.highRiskRepos ?? "?"}</strong></div>
      </div>
      <p style="margin-top:10px">
        <a href="/orgs/${encodeURIComponent(org.name)}" class="pill sel">Open briefing</a>
        <a href="/orgs/${encodeURIComponent(org.name)}/founder" class="pill">Founder hub</a>
      </p>
    </div>`;
  }).join("");

  const generatedAt = index.generatedAt ? new Date(index.generatedAt).toLocaleString() : null;
  const headerNote = generatedAt
    ? `<p class="muted" style="margin:0 0 12px">Last synced: ${escapeHtml(generatedAt)} · <a href="/risks">All risk signals</a> · <a href="/gtm">GTM ledger</a></p>`
    : `<div class="card" style="border-color:#713f12;background:#1c1208"><p style="margin:0">No index yet. Run <code>npm run org:sync:all</code> from your projects root first.</p></div>`;

  const flowSection = `<div class="section-title">Active Product Flows Across Orgs</div>${flowChips}`;

  return page("Org Intelligence", `<h1 style="margin-bottom:.2em">Org Intelligence</h1>${headerNote}${metricCards}${flowSection}<div class="section-title">Your Orgs</div><div class="grid">${orgCards || "<div class='card'>No orgs indexed yet.</div>"}</div>`);
}

async function renderOrg(options, orgName, index, runId, allRuns) {
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  if (!org) return notFoundPage("Org not found", orgName);

  const repos = org.signals?.repos || [];
  const summary = org.signals?.summary || org.summary || {};

  const executiveHtml = `<div class="card"><h2>Executive Metrics</h2><div class="grid"><div class="card"><p><strong>${summary.reposWithChanges ?? 0}</strong><br>Repos with changes</p></div><div class="card"><p><strong>${summary.criticalFlowHits ?? 0}</strong><br>Critical flow hits</p></div><div class="card"><p><strong>${summary.highRiskRepos ?? 0}</strong><br>High-risk repos</p></div><div class="card"><p>Deep: ${summary.deepReviewRecommended ? "<span class='pill bad'>needed</span>" : "<span class='pill ok'>ok</span>"} · Release: ${summary.releaseReviewRecommended ? "<span class='pill bad'>needed</span>" : "<span class='pill ok'>ok</span>"}</p></div></div></div>`;

  const visionDir = path.join(org.path, "vision");
  let founderLinks = `<p><a href="/orgs/${encodeURIComponent(orgName)}/product" class="pill sel">Product overview</a>`;
  if (existsSync(visionDir)) {
    const visionEntries = (await readdir(visionDir)).filter((f) => f.startsWith("weekly-analysis-"));
    const latestWeekly = visionEntries.sort().pop();
    if (latestWeekly) {
      founderLinks += ` · <a href="/orgs/${encodeURIComponent(orgName)}/weekly-analysis" class="pill sel">Weekly analysis</a>`;
    }
  }
  founderLinks += ` · <a href="/orgs/${encodeURIComponent(orgName)}" class="pill">Org dashboard</a></p>`;

  const capabilityMap = buildProductCapabilityMap(repos);
  const capabilityCards = capabilityMap.map((flow) => {
    const riskLines = flow.riskTags.slice(0, 4).map((risk) =>
      `<span class="pill">${escapeHtml(risk.label)} (${risk.repos.length} repos)</span>`
    ).join(" ");
    const repoList = flow.repos.map((r) => escapeHtml(r)).join(", ");
    return `<div class="card"><h3><span class="pill ${flowSeverityPill(flow.severity)}">${escapeHtml(flow.severity)}</span> ${escapeHtml(flow.label)}</h3><p class="muted">${flow.repos.length} repo${flow.repos.length > 1 ? "s" : ""}</p><details><summary style="cursor:pointer;font-size:.92em;color:#9ca3af">Repos</summary><p class="muted">${repoList}</p></details><p>${riskLines || "<span class='muted'>No risk tags</span>"}</p></div>`;
  }).join("") || "<div class='card'>No product flows detected yet.</div>";

  const repoCards = repos.map((repo) => {
    const projectUrl = runId
      ? `/orgs/${encodeURIComponent(orgName)}/projects/${encodeURIComponent(repo.name)}?run=${encodeURIComponent(runId)}`
      : `/orgs/${encodeURIComponent(orgName)}/projects/${encodeURIComponent(repo.name)}`;
    return `<div class="card"><h3><a href="${escapeHtml(projectUrl)}">${escapeHtml(repo.name)}</a></h3><p>Changed files: ${repo.changedFiles?.length || 0}</p><p>${(repo.productFlows || []).map((flow) => `<span class="pill warn">${escapeHtml(flow.label)}</span>`).join(" ") || "<span class='muted'>No product flow tags</span>"}</p><p>${(repo.riskTags || []).map((risk) => `<span class="pill">${escapeHtml(risk.label)}</span>`).join(" ") || "<span class='muted'>No risk tags</span>"}</p></div>`;
  }).join("");

  let runSelector = "";
  let effectiveRunId = null;
  const allPhysicalRuns = await discoverReportRuns(org.path);
  if (allPhysicalRuns.length > 0) {
    const toggleHref = allRuns ? `?${runId ? `run=${encodeURIComponent(runId)}&` : ""}` : `?allRuns=1${runId ? `&run=${encodeURIComponent(runId)}` : ""}`;
    const toggleLabel = allRuns ? "Show canonical daily runs" : "Show all runs";
    const toggleLink = `<a href="${escapeHtml(toggleHref)}" class="pill sel">${toggleLabel}</a>`;

    let runLinks;
    if (allRuns) {
      effectiveRunId = runId || null;
      runLinks = allPhysicalRuns.map((r) =>
        `<a href="?allRuns=1&run=${encodeURIComponent(r)}" class="pill ${r === runId ? "sel" : ""}">${escapeHtml(friendlyRunLabel(r))}</a>`
      ).join(" ");
    } else {
      const canonicalDays = await discoverCanonicalRuns(org.path);
      effectiveRunId = runId || (canonicalDays[0]?.canonical || null);
      runLinks = canonicalDays.map((day) => {
        const isActive = day.canonical === effectiveRunId || (!effectiveRunId && day.canonical === canonicalDays[0]?.canonical);
        const selClass = isActive ? " sel" : "";
        return `<a href="?run=${encodeURIComponent(day.canonical)}" class="pill${selClass}" title="${day.all.map((r) => friendlyRunLabel(r)).join(", ")}">${escapeHtml(day.date)}</a>`;
      }).join(" ");
    }

    let mainArtifactLinks = "";
    if (effectiveRunId && allPhysicalRuns.includes(effectiveRunId)) {
      const allKinds = Object.keys(ALLOWED_MAIN_ARTIFACT_KINDS);
      const agencyBriefKinds = allKinds.filter((k) => k.startsWith("agency-briefs/"));
      const otherKinds = allKinds.filter((k) => !k.startsWith("agency-briefs/"));
      mainArtifactLinks = `<p>Artifacts: ${otherKinds.map((kind) =>
        `<a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/${encodeURIComponent(kind)}">${escapeHtml(kind)}</a>`
      ).join(" · ")}</p>`;
      if (agencyBriefKinds.length && existsSync(path.join(org.path, "org-sync-reports", effectiveRunId, "agency-briefs"))) {
        mainArtifactLinks += `<details><summary style="cursor:pointer;font-size:.92em;color:#9ca3af">Agency briefs</summary><p>${agencyBriefKinds.map((kind) =>
          `<a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/${encodeURIComponent(kind)}">${escapeHtml(kind.replace("agency-briefs/", ""))}</a>`
        ).join(" · ")}</p></details>`;
      }
    }
    runSelector = `<details><summary style="cursor:pointer;font-size:1.1em;font-weight:600;padding:6px 0">Sync runs &amp; raw data</summary><div class="card"><p>${runLinks}</p><p>${toggleLink}</p>${mainArtifactLinks}</div></details>`;
  }

  let developerSection = "";
  const devs = (org.signals?.developers || []);
  if (devs.length > 0) {
    const devHtml = devs.slice(0, 10).map((d) => {
      const flowTags = (d.productFlows || []).map((f) => `<span class="pill warn">${escapeHtml(f.label)}</span>`).join(" ") || "";
      const riskTags = (d.riskTags || []).map((r) => `<span class="pill">${escapeHtml(r.label)}</span>`).join(" ") || "";
      return `<div class="card"><p><strong>${escapeHtml(d.name)}</strong> <${escapeHtml(d.email)}> — ${d.commits} commits</p><p>Repos: ${(d.repos || []).map((r) => escapeHtml(r)).join(", ") || "none"}</p>${flowTags ? `<p>${flowTags}</p>` : ""}${riskTags ? `<p>${riskTags}</p>` : ""}</div>`;
    }).join("");
    developerSection = `<details><summary style="cursor:pointer;font-size:1.1em;font-weight:600;padding:6px 0">Developer rollup (${devs.length})</summary><div class="grid">${devHtml}</div>${devs.length > 10 ? `<p class="muted">Showing 10 of ${devs.length} developers</p>` : ""}</details>`;
  }

  let weeklySummarySection = "";
  const weeklyDir = path.join(org.path, "org-sync-weekly");
  let latestWeekly = null;
  if (existsSync(weeklyDir)) {
    try {
      const weeklyEntries = await readdir(weeklyDir, { withFileTypes: true });
      const timestamps = weeklyEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, 5);
      latestWeekly = timestamps[0] || null;
      if (timestamps.length > 0) {
        const weeklyLinks = timestamps.map((ts) => {
          const mdLink = existsSync(path.join(weeklyDir, ts, "weekly-summary.md"))
            ? `<a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(ts)}/weekly-summary.md">weekly-summary.md</a>`
            : "";
          const devLink = existsSync(path.join(weeklyDir, ts, "developer-summary.md"))
            ? `<a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(ts)}/developer-summary.md">developer-summary.md</a>`
            : "";
          const agencyLink = existsSync(path.join(weeklyDir, ts, "agency-briefs"))
            ? `<span class="pill ok">weekly agency briefs ready</span>`
            : `<span class="pill warn">no weekly agency briefs</span>`;
          const jsonLink = existsSync(path.join(weeklyDir, ts, "weekly-summary.json"))
            ? `<a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(ts)}/weekly-summary.json">weekly-summary.json</a>`
            : "";
          return `<div class="card"><p><strong>${escapeHtml(ts)}</strong></p><p>${agencyLink}</p><p>${[mdLink, devLink, jsonLink].filter(Boolean).join(" · ")}</p></div>`;
        }).join("");
        weeklySummarySection = `<details open><summary style="cursor:pointer;font-size:1.1em;font-weight:600;padding:6px 0">Weekly Intelligence (${timestamps.length})</summary>${weeklyLinks}</details>`;
      }
    } catch {
      weeklySummarySection = "";
    }
  }

  const latestRunSummary = await loadRunSummary(org.path, effectiveRunId || allPhysicalRuns[0]);
  const llmStatus = llmStatusForRun(latestRunSummary);
  const founderSyncRun = await latestFounderSyncRun(org.path);
  const founderPaths = {
    "vision/goals.md": existsSync(path.join(org.path, "vision", "goals.md")),
    "vision/founder-input.md": existsSync(path.join(org.path, "vision", "founder-input.md")),
    "vision/todos.md": existsSync(path.join(org.path, "vision", "todos.md")),
  };
  const warnings = setupWarnings(org, latestRunSummary, founderPaths);
  const warningHtml = warnings.length
    ? `<div class="card"><h2>Setup / Attention</h2><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
    : "";

  const dailyRel = await latestVisionDatedFile(org.path, "daily");
  const decisionsRel = await latestVisionDatedFile(org.path, "decisions");
  const researchRel = await latestVisionDatedFile(org.path, "research");
  const founderHub = `<div class="card"><h2>Founder Hub</h2><p><a href="/orgs/${encodeURIComponent(orgName)}/founder" class="pill sel">Open founder hub</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/todos" class="pill">Todos</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/gtm-experiments" class="pill">GTM ledger</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/goals" class="pill">Goals</a></p><p>${dailyRel ? `<a class="pill ok" href="/orgs/${encodeURIComponent(orgName)}/vision/daily">Latest daily</a>` : `<span class="pill warn">No daily note</span>`} ${decisionsRel ? `<a class="pill ok" href="/orgs/${encodeURIComponent(orgName)}/vision/decisions">Latest decisions</a>` : `<span class="pill warn">No decisions note</span>`} ${researchRel ? `<a class="pill" href="/orgs/${encodeURIComponent(orgName)}/vision/research">Latest research</a>` : `<span class="pill">No research note</span>`}</p><p>Founder-sync run: ${founderSyncRun ? `<span class="pill ok">${escapeHtml(friendlyRunLabel(founderSyncRun))}</span>` : `<span class="pill warn">none found</span>`}</p></div>`;

  const intelligenceHtml = `<div class="card"><h2>Intelligence Status</h2><div class="grid"><div class="card"><p><strong>OpenCode / LLM</strong><br><span class="pill ${llmStatus.cls}">${escapeHtml(llmStatus.label)}</span></p><p class="muted">${escapeHtml(llmStatus.detail)}</p></div><div class="card"><p><strong>Latest run</strong><br>${effectiveRunId ? escapeHtml(friendlyRunLabel(effectiveRunId)) : "none"}</p><p>${effectiveRunId ? `<a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/report">Daily report</a> · <a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/run-summary">run-summary</a>` : "No daily run."}</p></div><div class="card"><p><strong>Weekly</strong><br>${latestWeekly ? escapeHtml(friendlyRunLabel(latestWeekly)) : "none"}</p><p>${latestWeekly ? `<a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(latestWeekly)}/weekly-summary.md">Weekly summary</a> · <a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(latestWeekly)}/developer-summary.md">Developer summary</a>` : "No weekly summary."}</p></div></div></div>`;

  if (!developerSection && latestWeekly && existsSync(path.join(org.path, "org-sync-weekly", latestWeekly, "developer-summary.md"))) {
    const weeklyJson = await readJson(path.join(org.path, "org-sync-weekly", latestWeekly, "weekly-summary.json"), null).catch(() => null);
    const weeklyDevs = weeklyJson?.developers || [];
    const weeklyDevCards = weeklyDevs.slice(0, 10).map((d) => `<div class="card"><p><strong>${escapeHtml(d.name)}</strong> &lt;${escapeHtml(d.email)}&gt; — ${d.commits || 0} commits</p><p>Repos: ${(d.repos || []).map((r) => escapeHtml(r)).join(", ") || "none"}</p></div>`).join("");
    developerSection = `<details open><summary style="cursor:pointer;font-size:1.1em;font-weight:600;padding:6px 0">Developer Summary — weekly sync${weeklyDevs.length ? ` (${weeklyDevs.length})` : ""}</summary><div class="card"><p><a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(latestWeekly)}/developer-summary.md" class="pill sel">Open weekly developer summary</a> <a href="/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(latestWeekly)}/weekly-summary.json" class="pill">Structured weekly data</a></p></div>${weeklyDevCards ? `<div class="grid">${weeklyDevCards}</div>` : `<div class="card"><p class="muted">Developer summary artifact exists, but no structured developer rows were found. Open the Markdown summary for details.</p></div>`}</details>`;
  } else if (developerSection) {
    developerSection = developerSection.replace("Developer rollup", "Developer Summary — daily sync");
  } else {
    developerSection = `<details open><summary style="cursor:pointer;font-size:1.1em;font-weight:600;padding:6px 0">Developer Summary</summary><div class="card"><p class="muted">No developer summary found yet. Run daily sync or weekly sync to generate developer rollups.</p></div></details>`;
  }

  // ── TODAY'S DIGEST ──────────────────────────────────────────────────────────
  let digestHtml = "";
  const founderDailyPath = await readLatestFounderDaily(org.path);
  if (founderDailyPath) {
    const dailyContent = await readTextPreview(founderDailyPath, 3000).catch(() => null);
    const execRead = dailyContent ? extractMarkdownSection(dailyContent, "Executive Read", 900) : null;
    const whatChanged = dailyContent ? extractMarkdownSection(dailyContent, "What Changed", 600) : null;
    const moves = dailyContent ? extractMarkdownSection(dailyContent, "Recommended Moves", 500) : null;
    const dateLabel = path.basename(founderDailyPath, ".md");
    if (execRead || whatChanged) {
      const digestBody = [
        execRead ? `<div class="markdown-body">${safeMarkdownToHtml(execRead)}</div>` : "",
        whatChanged ? `<h3 style="margin-top:.8em;color:#94a3b8;font-size:.82em;text-transform:uppercase;letter-spacing:.06em">What Changed</h3><div class="markdown-body">${safeMarkdownToHtml(whatChanged)}</div>` : "",
        moves ? `<h3 style="margin-top:.8em;color:#94a3b8;font-size:.82em;text-transform:uppercase;letter-spacing:.06em">Recommended Moves</h3><div class="markdown-body">${safeMarkdownToHtml(moves)}</div>` : "",
      ].filter(Boolean).join("");
      digestHtml = `<div class="digest"><div class="digest-label">Today's Briefing · ${escapeHtml(dateLabel)}</div>${digestBody}<p style="margin-top:12px"><a href="/orgs/${encodeURIComponent(orgName)}/vision/daily" class="pill sel">Open full daily note</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/decisions" class="pill">Decisions</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/todos" class="pill">Todos</a></p></div>`;
    }
  }
  if (!digestHtml && effectiveRunId) {
    const reportFilePath = path.join(org.path, "org-sync-reports", effectiveRunId, "report.md");
    const reportContent = await readTextPreview(reportFilePath, 2000).catch(() => null);
    if (reportContent) {
      const execSummary = extractMarkdownSection(reportContent, "Executive Summary", 800) || reportContent.slice(0, 600);
      digestHtml = `<div class="digest"><div class="digest-label">Engineering Report · ${escapeHtml(friendlyRunLabel(effectiveRunId))}</div><div class="markdown-body">${safeMarkdownToHtml(execSummary)}</div><p style="margin-top:12px"><a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/report" class="pill sel">Open full report</a></p></div>`;
    }
  }
  if (!digestHtml) {
    digestHtml = `<div class="digest" style="border-color:#334155"><div class="digest-label">No briefing yet</div><p style="margin:.4em 0;color:#94a3b8">Run <code>npm run org:sync:all</code> to generate your first report, then <code>npm run founder:sync</code> for the full briefing.</p></div>`;
  }

  // ── AGENCY BRIEFS (inline previews) ─────────────────────────────────────────
  const agencyDomains = ["product", "gtm", "sales", "marketing", "engineering", "customer-success"];
  const agencyBriefCards = await Promise.all(agencyDomains.map(async (domain) => {
    const dailyBriefPath = effectiveRunId ? path.join(org.path, "org-sync-reports", effectiveRunId, "agency-briefs", `${domain}.md`) : null;
    const weeklyBriefPath = latestWeekly ? path.join(org.path, "org-sync-weekly", latestWeekly, "agency-briefs", `${domain}.md`) : null;
    const briefPath = (dailyBriefPath && existsSync(dailyBriefPath)) ? dailyBriefPath
      : (weeklyBriefPath && existsSync(weeklyBriefPath)) ? weeklyBriefPath : null;
    const label = domain.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
    const briefKind = `agency-briefs/${domain}`;
    const briefSource = (dailyBriefPath && existsSync(dailyBriefPath)) ? "daily" : (weeklyBriefPath && existsSync(weeklyBriefPath)) ? "weekly" : null;
    const briefHref = briefPath
      ? (briefSource === "daily"
        ? `/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(effectiveRunId)}/${encodeURIComponent(briefKind)}`
        : `/orgs/${encodeURIComponent(orgName)}/weekly/${encodeURIComponent(latestWeekly)}/${encodeURIComponent(briefKind)}`)
      : null;
    if (!briefPath) {
      return `<div class="brief-card"><div class="brief-domain">${escapeHtml(label)}</div><p class="muted" style="margin:.3em 0;font-size:.88em">No brief yet.</p></div>`;
    }
    const briefContent = await readTextPreview(briefPath, 5000).catch(() => null);
    const questions = briefContent ? extractMarkdownSection(briefContent, "Domain-Specific Questions", 700) : null;
    const previewHtml = questions
      ? `<div class="markdown-body" style="font-size:.88em">${safeMarkdownToHtml(questions)}</div>`
      : `<p class="muted" style="font-size:.88em">Brief generated — <a href="${escapeHtml(briefHref)}">open to read</a>.</p>`;
    return `<div class="brief-card"><div class="brief-domain">${escapeHtml(label)} <span class="pill sel" style="font-size:.7em;vertical-align:middle">${escapeHtml(briefSource)}</span>${briefHref ? ` <a href="${escapeHtml(briefHref)}" style="font-size:.8em;float:right;color:#7dd3fc">open →</a>` : ""}</div>${previewHtml}</div>`;
  }));
  const agencySection = `<div class="section-title">Agency Intelligence — Questions to answer today</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px">${agencyBriefCards.join("")}</div>`;

  // ── SIGNALS ──────────────────────────────────────────────────────────────────
  const signalRows = sellRiskSignals(repos).map((s) =>
    `<div class="signal-row"><span class="signal-num" style="color:${s.cls === "bad" ? "#fca5a5" : s.cls === "warn" ? "#fcd34d" : "#86efac"}">${s.count}</span><span class="signal-label">${escapeHtml(s.label)}<br><small>${escapeHtml(s.detail)}</small></span></div>`
  ).join("");
  const metricRow = `<div class="grid-3" style="margin-bottom:10px">
    <div class="card-sm"><div class="label">Repos Changed</div><div class="num">${summary.reposWithChanges ?? 0}</div></div>
    <div class="card-sm"><div class="label">Critical Flows</div><div class="num" style="color:${(summary.criticalFlowHits||0)>0?"#fca5a5":"#86efac"}">${summary.criticalFlowHits ?? 0}</div></div>
    <div class="card-sm"><div class="label">High-Risk Repos</div><div class="num" style="color:${(summary.highRiskRepos||0)>0?"#fcd34d":"#86efac"}">${summary.highRiskRepos ?? 0}</div></div>
  </div>`;
  const reviewPills = [
    summary.deepReviewRecommended ? `<span class="pill bad">Deep review needed</span>` : `<span class="pill ok">No deep-review trigger</span>`,
    summary.releaseReviewRecommended ? `<span class="pill bad">Release gated</span>` : `<span class="pill ok">Release signals ok</span>`,
  ].join(" ");
  const decisionSection = `<div class="section-title">Signals &amp; Alerts</div>${metricRow}<div class="card">${signalRows}<p style="margin:.8em 0 0">${reviewPills}</p></div>`;

  // ── PAGE ASSEMBLY ────────────────────────────────────────────────────────────
  return page(orgName, `
<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
  <h1 style="margin:0">${escapeHtml(orgName)}</h1>
  <span class="pill ${statusClass(org.status)}">${escapeHtml(org.status)}</span>
  <a href="/" style="font-size:.88em;color:#94a3b8">← All orgs</a>
</div>
<p style="margin:.3em 0 14px"><a href="/orgs/${encodeURIComponent(orgName)}/founder" class="pill sel">Founder hub</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/todos" class="pill">Todos</a> <a href="/orgs/${encodeURIComponent(orgName)}/vision/gtm-experiments" class="pill">GTM ledger</a> <a href="/orgs/${encodeURIComponent(orgName)}/product" class="pill">Product overview</a></p>
${warningHtml}
${digestHtml}
${decisionSection}
${agencySection}
<div class="section-title">Founder Hub</div>
${founderHub}
<details><summary>Intelligence &amp; Sync Status</summary>${intelligenceHtml}</details>
<details><summary>Developer Activity</summary>${developerSection}</details>
${weeklySummarySection ? `<details><summary>Weekly Intelligence</summary>${weeklySummarySection}</details>` : ""}
<details><summary>Product Capability Map</summary><div class="grid">${capabilityCards}</div></details>
<details><summary>Projects (${repos.length})</summary><div class="grid">${repoCards || "<div class='card'>No repo signals yet.</div>"}</div></details>
${runSelector}
<details><summary style="color:#4b5563;font-size:.85em">Raw filesystem paths</summary><p class="muted" style="font-size:.82em">${escapeHtml(org.path)}</p></details>
`);
}

function renderProjectRunDetail(orgName, repoName, runId, summary) {
  const artifactLinks = Object.keys(ALLOWED_ARTIFACT_KINDS).map((kind) =>
    `<a href="/orgs/${encodeURIComponent(orgName)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(repoName)}/${encodeURIComponent(kind)}">${escapeHtml(kind)}</a>`
  ).join(" · ");

  const after = summary.after || {};
  const git = summary.git || {};
  const uncommitted = summary.uncommitted || {};
  const warnings = summary.warnings || [];

  let html = `<h1>${escapeHtml(repoName)}</h1>`;
  html += `<p class="muted">Run: ${escapeHtml(friendlyRunLabel(runId))}</p>`;
  html += `<p><a href="/orgs/${encodeURIComponent(orgName)}?run=${encodeURIComponent(runId)}">← Back to org</a></p>`;

  html += `<div class="card"><h2>Git state</h2>`;
  html += `<p>Branch: <code>${escapeHtml(after.branch || "?")}</code></p>`;
  html += `<p>Head: <code>${escapeHtml(after.head || "?")}</code></p>`;
  html += `<p>Remote: ${escapeHtml(after.remote || "?")}</p>`;
  html += `<p>Dirty: ${after.dirty ? "yes" : "no"}</p></div>`;

  html += `<div class="card"><h2>Committed changes</h2>`;
  html += `<p>Range: <code>${escapeHtml(git.range || "—")}</code></p>`;
  html += `<pre>${escapeHtml(git.shortstat || git.stat || "No committed changes.")}</pre>`;
  if (git.log) {
    html += `<details><summary style="cursor:pointer;font-weight:600">Commit log</summary><pre>${escapeHtml(git.log)}</pre></details>`;
  }
  html += `<details><summary style="cursor:pointer;font-weight:600">Developers</summary><p>${escapeHtml(git.developerSummary || "None.")}</p>`;
  if ((git.developers || []).length > 0) {
    html += `<pre>${escapeHtml(JSON.stringify(git.developers, null, 2))}</pre>`;
  }
  if (git.errors && git.errors.length > 0) {
    html += `<h3>Git errors</h3><pre class="bad">${escapeHtml(git.errors.join("\n"))}</pre>`;
  }
  html += `</details></div>`;

  html += `<div class="card"><h2>Uncommitted changes</h2>`;
  html += `<pre>${escapeHtml(uncommitted.worktreeStat || "None.")}</pre>`;
  if (uncommitted.untrackedFiles || uncommitted.worktreeNameStatus) {
    html += `<details><summary style="cursor:pointer;font-weight:600">Status details</summary><pre>${escapeHtml(uncommitted.worktreeNameStatus || uncommitted.untrackedFiles || "")}</pre></details>`;
  }
  html += `</div>`;

  html += `<div class="card"><h2>Warnings</h2>`;
  if (warnings.length > 0) {
    html += `<pre class="warn">${escapeHtml(warnings.join("\n"))}</pre>`;
  } else {
    html += `<p class="muted">None.</p>`;
  }
  html += `</div>`;

  html += `<div class="card"><h2>Product flows</h2>`;
  html += (summary.productFlows || []).map((flow) => `<p><span class="pill warn">${escapeHtml(flow.label)} (${flow.severity})</span></p>`).join("") || "<p class='muted'>None.</p>";
  html += `</div>`;

  html += `<div class="card"><h2>Risk tags</h2>`;
  html += (summary.riskTags || []).map((risk) => `<p><span class="pill">${escapeHtml(risk.label)} (${risk.severity})</span></p>`).join("") || "<p class='muted'>None.</p>";
  html += `</div>`;

  html += `<div class="card"><h2>Artifacts</h2><p>${artifactLinks}</p></div>`;

  return html;
}

async function renderProject(options, orgName, repoName, index, runId) {
  if (!validateRepoName(repoName)) return notFoundPage("Project not found", `${orgName} / ${repoName}`);
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  const repo = org?.signals?.repos?.find((item) => item.name === repoName);
  if (!repo) return notFoundPage("Project not found", `${orgName} / ${repoName}`);

  const runExists = runId ? await validateRunExists(org.path, runId) : null;
  if (runExists) {
    const summaryPath = path.join(org.path, "org-sync-reports", runId, "repos", repoName, "summary.json");
    const summary = await readJson(summaryPath, null);
    if (summary) {
      return page(`${orgName} / ${repoName}`, renderProjectRunDetail(orgName, repoName, runId, summary));
    }
  }

  const changedFilesContent = (repo.changedFiles || []).map((file) => `${file.status} ${file.path}`).join("\n") || "None";
  return page(`${orgName} / ${repoName}`, `<h1>${escapeHtml(repoName)}</h1><p class="muted">${escapeHtml(repo.path)}</p><div class="card"><h2>Review</h2><p>Deep recommended: ${repo.review?.deepRecommended ? "yes" : "no"}</p><ul>${(repo.review?.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("") || "<li>No trigger.</li>"}</ul></div><div class="card"><h2>Product flows</h2>${(repo.productFlows || []).map((flow) => `<p><span class="pill warn">${escapeHtml(flow.label)} (${flow.severity})</span></p>`).join("") || "<p class='muted'>None.</p>"}</div><div class="card"><h2>Risk tags</h2>${(repo.riskTags || []).map((risk) => `<p><span class="pill">${escapeHtml(risk.label)} (${risk.severity})</span></p>`).join("") || "<p class='muted'>None.</p>"}</div><details><summary style="cursor:pointer;font-weight:600">Changed files (${(repo.changedFiles || []).length})</summary><div class="card"><pre>${escapeHtml(changedFilesContent)}</pre></div></details>`);
}

async function renderMainArtifact(options, orgName, runId, kind, raw) {
  const index = await loadIndex(options);
  const validOrg = validateOrgName(orgName, index);
  if (!validOrg) return notFoundPage("Not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validOrg}.json`));
  if (!org) return notFoundPage("Not found", orgName);

  if (!ALLOWED_MAIN_ARTIFACT_KINDS[kind]) return notFoundPage("Invalid artifact kind", kind);

  const runExists = await validateRunExists(org.path, runId);
  if (!runExists) return notFoundPage("Run not found", `${orgName} / ${runId}`);

  const reportRoot = path.resolve(path.join(org.path, "org-sync-reports", runId));
  const filePath = safeMainArtifactPath(reportRoot, kind);
  if (!filePath) return notFoundPage("Access denied", kind);

  if (!existsSync(filePath)) return notFoundPage("Artifact not found", kind);

  const content = await readFile(filePath, "utf8");
  const fileName = ALLOWED_MAIN_ARTIFACT_KINDS[kind];
  const isMarkdown = fileName.endsWith(".md");
  const backlink = `/orgs/${encodeURIComponent(validOrg)}?run=${encodeURIComponent(runId)}`;

  if (raw) {
    return page(`Artifact: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a></p><pre>${escapeHtml(content)}</pre>`);
  }

  if (isMarkdown) {
    const bodyHtml = safeMarkdownToHtml(content);
    return page(`Report: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a> · <a href="?raw=1">View raw</a></p><div class="markdown-body">${bodyHtml}</div>`);
  }

  return page(`Report: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a> · <a href="?raw=1">View raw</a></p>${renderJsonContent(content)}`);
}

async function renderArtifact(options, orgName, runId, repoName, kind, raw) {
  const index = await loadIndex(options);
  const validOrg = validateOrgName(orgName, index);
  if (!validOrg) return notFoundPage("Not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validOrg}.json`));
  if (!org) return notFoundPage("Not found", orgName);

  if (!ALLOWED_ARTIFACT_KINDS[kind]) return notFoundPage("Invalid artifact kind", kind);

  const validRepo = validateRepoName(repoName);
  if (!validRepo) return notFoundPage("Invalid repo", repoName);

  const runExists = await validateRunExists(org.path, runId);
  if (!runExists) return notFoundPage("Run not found", `${orgName} / ${runId}`);

  const reportRoot = path.resolve(path.join(org.path, "org-sync-reports", runId));
  const filePath = safeArtifactPath(reportRoot, repoName, kind);
  if (!filePath) return notFoundPage("Access denied", kind);
  if (!existsSync(filePath)) return notFoundPage("Artifact not found", `${repoName}/${kind}`);

  const content = await readFile(filePath, "utf8");
  const fileName = ALLOWED_ARTIFACT_KINDS[kind];
  const isMarkdown = fileName.endsWith(".md");
  const backlink = `/orgs/${encodeURIComponent(validOrg)}/projects/${encodeURIComponent(repoName)}?run=${encodeURIComponent(runId)}`;

  if (raw) {
    return page(`Artifact: ${kind}`, `<h1>${escapeHtml(kind)} — ${escapeHtml(repoName)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to project</a></p><pre>${escapeHtml(content)}</pre>`);
  }

  if (isMarkdown) {
    const bodyHtml = safeMarkdownToHtml(content);
    return page(`Report: ${kind}`, `<h1>${escapeHtml(kind)} — ${escapeHtml(repoName)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to project</a> · <a href="?raw=1">View raw</a></p><div class="markdown-body">${bodyHtml}</div>`);
  }

  return page(`Report: ${kind}`, `<h1>${escapeHtml(kind)} — ${escapeHtml(repoName)}</h1><p class="muted">${escapeHtml(path.relative(reportRoot, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to project</a> · <a href="?raw=1">View raw</a></p>${renderJsonContent(content)}`);
}

async function renderOrgProduct(options, orgName) {
  const index = await loadIndex(options);
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  if (!org) return notFoundPage("Org not found", orgName);

  const filePath = await safeVisionFilePath(org.path, "product-overview.md");
  if (!filePath) return notFoundPage("Product overview not found", `${orgName}/vision/product-overview.md`);

  const content = await readFile(filePath, "utf8");
  const bodyHtml = safeMarkdownToHtml(content);
  return page(`Product overview — ${orgName}`, `<p><a href="/orgs/${encodeURIComponent(validName)}">← Back to ${escapeHtml(validName)}</a></p><div class="markdown-body">${bodyHtml}</div>`);
}

const WEEKLY_ANALYSIS_RE = /^weekly-analysis-\d{4}-\d{2}-\d{2}\.md$/;

async function renderOrgWeeklyAnalysis(options, orgName) {
  const index = await loadIndex(options);
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  if (!org) return notFoundPage("Org not found", orgName);

  const visionRoot = await safeVisionFilePath(org.path, ".");
  if (!visionRoot) return notFoundPage("No vision directory", `${orgName}/vision`);

  const entries = await readdir(visionRoot);
  const weeklyEntries = entries
    .filter((f) => WEEKLY_ANALYSIS_RE.test(f))
    .sort();

  if (weeklyEntries.length === 0) return notFoundPage("No weekly analysis found", `${orgName}/vision/`);

  const latest = weeklyEntries.pop();
  const filePath = await safeVisionFilePath(org.path, latest);
  if (!filePath) return notFoundPage("Access denied", latest);

  const content = await readFile(filePath, "utf8");
  const bodyHtml = safeMarkdownToHtml(content);
  return page(`Weekly analysis — ${orgName}`, `<p><a href="/orgs/${encodeURIComponent(validName)}/product">← Product overview</a> · <a href="/orgs/${encodeURIComponent(validName)}">← Org dashboard</a></p><div class="markdown-body">${bodyHtml}</div>`);
}

async function renderVisionArtifact(options, orgName, kind, raw) {
  const index = await loadIndex(options);
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  if (!org) return notFoundPage("Org not found", orgName);
  if (!VISION_STATIC_FILES[kind] && !VISION_LATEST_KINDS.has(kind)) return notFoundPage("Invalid vision artifact", kind);

  const filePath = await safeVisionKindPath(org.path, kind);
  if (!filePath) return notFoundPage("Vision artifact not found", `${orgName}/${kind}`);

  const content = await readFile(filePath, "utf8");
  const backlink = `/orgs/${encodeURIComponent(validName)}/founder`;
  if (raw) return page(`Vision: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p><a href="${escapeHtml(backlink)}">← Founder hub</a></p><pre>${escapeHtml(content)}</pre>`);
  return page(`Vision: ${kind}`, `<p><a href="${escapeHtml(backlink)}">← Founder hub</a> · <a href="?raw=1">View raw</a></p><div class="markdown-body">${safeMarkdownToHtml(content)}</div>`);
}

async function renderFounderHub(options, orgName) {
  const index = await loadIndex(options);
  const validName = validateOrgName(orgName, index);
  if (!validName) return notFoundPage("Org not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validName}.json`));
  if (!org) return notFoundPage("Org not found", orgName);

  const staticKinds = ["goals", "founder-input", "questions", "todos", "gtm-experiments", "product-overview"];
  const datedKinds = ["daily", "decisions", "research"];
  const staticCards = staticKinds.map((kind) => {
    const file = VISION_STATIC_FILES[kind];
    const exists = existsSync(path.join(org.path, "vision", file));
    return `<div class="card"><h3>${escapeHtml(kind.replace(/-/g, " "))}</h3><p>${exists ? `<span class="pill ok">ready</span>` : `<span class="pill warn">missing</span>`}</p><p>${exists ? `<a href="/orgs/${encodeURIComponent(validName)}/vision/${encodeURIComponent(kind)}">Open</a>` : "Add this file under vision/."}</p></div>`;
  }).join("");
  const datedCards = [];
  for (const kind of datedKinds) {
    const rel = await latestVisionDatedFile(org.path, kind);
    datedCards.push(`<div class="card"><h3>${escapeHtml(kind)}</h3><p>${rel ? `<span class="pill ok">${escapeHtml(path.basename(rel, ".md"))}</span>` : `<span class="pill warn">missing</span>`}</p><p>${rel ? `<a href="/orgs/${encodeURIComponent(validName)}/vision/${encodeURIComponent(kind)}">Open latest</a>` : "No generated note yet."}</p></div>`);
  }
  const founderRun = await latestFounderSyncRun(org.path);
  const founderRunHtml = `<div class="card"><h2>Founder Sync</h2><p>${founderRun ? `<span class="pill ok">latest: ${escapeHtml(friendlyRunLabel(founderRun))}</span>` : `<span class="pill warn">No founder-sync-runs folder</span>`}</p><p class="muted">Founder sync invokes OpenCode by default in the current SOP. Dashboard only reads generated outputs.</p></div>`;
  return page(`Founder hub — ${validName}`, `<h1>${escapeHtml(validName)} Founder Hub</h1><p><a href="/orgs/${encodeURIComponent(validName)}">← Command center</a></p>${founderRunHtml}<h2>Founder Inputs</h2><div class="grid">${staticCards}</div><h2>Latest Founder Outputs</h2><div class="grid">${datedCards.join("")}</div>`);
}

async function renderWeeklyArtifact(options, orgName, timestamp, kind, raw) {
  const index = await loadIndex(options);
  const validOrg = validateOrgName(orgName, index);
  if (!validOrg) return notFoundPage("Not found", orgName);
  const org = await readJson(path.join(options.globalDir, "orgs", `${validOrg}.json`));
  if (!org) return notFoundPage("Not found", orgName);

  if (!ALLOWED_WEEKLY_ARTIFACT_KINDS[kind]) return notFoundPage("Invalid artifact kind", kind);
  const filePath = safeWeeklyArtifactPath(org.path, timestamp, kind);
  if (!filePath) return notFoundPage("Access denied", kind);
  if (!existsSync(filePath)) return notFoundPage("Artifact not found", `${timestamp}/${kind}`);

  const content = await readFile(filePath, "utf8");
  const fileName = ALLOWED_WEEKLY_ARTIFACT_KINDS[kind];
  const isMarkdown = fileName.endsWith(".md");
  const backlink = `/orgs/${encodeURIComponent(validOrg)}`;

  if (raw) {
    return page(`Weekly: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(org.path, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a></p><pre>${escapeHtml(content)}</pre>`);
  }

  if (isMarkdown) {
    const bodyHtml = safeMarkdownToHtml(content);
    return page(`Weekly: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(org.path, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a> · <a href="?raw=1">View raw</a></p><div class="markdown-body">${bodyHtml}</div>`);
  }

  return page(`Weekly: ${kind}`, `<h1>${escapeHtml(kind)}</h1><p class="muted">${escapeHtml(path.relative(org.path, filePath))}</p><p><a href="${escapeHtml(backlink)}">← Back to org</a> · <a href="?raw=1">View raw</a></p>${renderJsonContent(content)}`);
}

async function renderGrouped(options, kind) {
  const index = await loadIndex(options);
  const lines = [];
  for (const orgRef of index.orgs || []) {
    const org = await readJson(path.join(options.globalDir, "orgs", `${orgRef.name}.json`));
    if (kind === "risks") {
      for (const repo of org?.signals?.repos || []) for (const risk of repo.riskTags || []) lines.push(`<li><a href="/orgs/${encodeURIComponent(org.name)}/projects/${encodeURIComponent(repo.name)}">${escapeHtml(org.name)} / ${escapeHtml(repo.name)}</a>: ${escapeHtml(risk.label)} (${escapeHtml(risk.severity)})</li>`);
    } else if (kind === "founder") {
      lines.push(`<li><a href="/orgs/${encodeURIComponent(org.name)}">${escapeHtml(org.name)}</a>: ${escapeHtml(org.status)} · ${org.signals?.summary?.deepReviewRecommended ? "deep review needed" : "no deep review trigger"}</li>`);
    } else if (kind === "gtm") {
      lines.push(`<li><a href="file://${escapeHtml(path.join(org.path, "vision", "gtm-experiments.md"))}">${escapeHtml(org.name)} GTM experiments</a></li>`);
    }
  }
  return page(kind, `<h1>${escapeHtml(kind)}</h1><div class="card"><ul>${lines.join("") || "<li>No data yet.</li>"}</ul></div>`);
}

async function handle(req, res, options) {
  const url = new URL(req.url, `http://localhost:${options.port}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const index = await loadIndex(options);
  const run = url.searchParams.get("run") || null;
  const raw = url.searchParams.has("raw");
  const allRuns = options.allRuns || url.searchParams.has("allRuns");
  let html;
  if (parts.length === 0) html = await renderHome(options);
  else if (parts[0] === "orgs" && parts[2] === "product" && parts.length === 3) html = await renderOrgProduct(options, parts[1]);
  else if (parts[0] === "orgs" && parts[2] === "weekly-analysis" && parts.length === 3) html = await renderOrgWeeklyAnalysis(options, parts[1]);
  else if (parts[0] === "orgs" && parts[2] === "founder" && parts.length === 3) html = await renderFounderHub(options, parts[1]);
  else if (parts[0] === "orgs" && parts[2] === "vision" && parts.length === 4) html = await renderVisionArtifact(options, parts[1], parts[3], raw);
  else if (parts[0] === "orgs" && parts.length === 2) html = await renderOrg(options, parts[1], index, run, allRuns);
  else if (parts[0] === "orgs" && parts[2] === "projects" && parts.length === 4) html = await renderProject(options, parts[1], parts[3], index, run);
  else if (parts[0] === "orgs" && parts[2] === "runs" && parts[4] === "artifacts" && parts.length === 7) html = await renderArtifact(options, parts[1], parts[3], parts[5], parts[6], raw);
  else if (parts[0] === "orgs" && parts[2] === "runs" && parts.length === 5 && ALLOWED_MAIN_ARTIFACT_KINDS[parts[4]] !== undefined) html = await renderMainArtifact(options, parts[1], parts[3], parts[4], raw);
  else if (parts[0] === "orgs" && parts[2] === "weekly" && parts.length === 5 && ALLOWED_WEEKLY_ARTIFACT_KINDS[parts[4]] !== undefined) html = await renderWeeklyArtifact(options, parts[1], parts[3], parts[4], raw);
  else if (["risks", "founder", "gtm"].includes(parts[0])) html = await renderGrouped(options, parts[0]);
  else html = page("Not found", "<h1>Not found</h1>");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  createServer((req, res) => {
    handle(req, res, options).catch((error) => {
      console.error(error);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal dashboard error. See terminal logs.");
    });
  }).listen(options.port, "127.0.0.1", () => {
    console.log(`Org dashboard: http://localhost:${options.port}`);
    console.log(`Projects root: ${options.projectsRoot}`);
  });
}

main().catch((error) => {
  console.error(`org-dashboard failed: ${error.message}`);
  process.exitCode = 1;
});
