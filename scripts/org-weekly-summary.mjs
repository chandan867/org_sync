#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SINCE_DAYS = 7;

function usage() {
  return `org-weekly-summary: read daily org-sync reports and write weekly developer-wise summaries.

Reads existing org-sync-reports/*/run-summary.json and founder-signals.json,
filters to last N days, and writes weekly artifacts without re-running git.

Usage:
  org-weekly-summary --org-root <path>
  org-weekly-summary --org-root <path> --since-days 14
  org-weekly-summary --org-root <path> --dry-run
  npm run org:weekly -- --org-root /path/to/org

Options:
  --org-root <path>   Folder containing org-sync-reports/. Required.
  --since-days <n>    Number of past days to include. Default: ${DEFAULT_SINCE_DAYS}.
  --output-dir <path> Output directory. Default: <org-root>/org-sync-weekly/<timestamp>.
  --dry-run           Print planned actions without writing files.
  --help              Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    orgRoot: null,
    sinceDays: DEFAULT_SINCE_DAYS,
    outputDir: null,
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
      case "--since-days": {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--since-days must be a positive integer");
        options.sinceDays = parsed;
        break;
      }
      case "--output-dir":
        options.outputDir = path.resolve(next());
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
  return options;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function dateParts(yyyyMmDd) {
  const [year, month] = yyyyMmDd.split("-");
  return { year, month, yyyyMmDd };
}

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function parseRunDate(runId) {
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  const iso = `${runId.slice(0, 10)}T${runId.slice(11, 13)}:${runId.slice(14, 16)}:${runId.slice(17, 19)}.${runId.slice(20, 23)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function discoverReportRuns(orgRoot) {
  const reportsDir = path.join(orgRoot, "org-sync-reports");
  if (!existsSync(reportsDir)) return [];
  const entries = await readdir(reportsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

function aggregateDevelopersFromRuns(runs) {
  const byKey = new Map();
  for (const run of runs) {
    const runDevelopers = (run.developers && run.developers.length > 0)
      ? run.developers
      : (run._founderSignals?.developers && run._founderSignals.developers.length > 0)
        ? run._founderSignals.developers
        : aggregateDevelopersFromRepoSummaries(run.repos || []);
    for (const dev of runDevelopers) {
      const key = `${dev.name} <${dev.email}>`;
      if (!byKey.has(key)) {
        byKey.set(key, { name: dev.name, email: dev.email, commits: 0, repos: [], commitSubjects: [], productFlows: [], riskTags: [], days: [] });
      }
      const record = byKey.get(key);
      record.commits += dev.commits || 0;
      for (const r of (dev.repos || [])) {
        if (!record.repos.includes(r)) record.repos.push(r);
      }
      for (const s of (dev.commitSubjects || [])) {
        if (!record.commitSubjects.includes(s)) record.commitSubjects.push(s);
      }
      for (const flow of (dev.productFlows || [])) {
        if (!record.productFlows.some((f) => f.id === flow.id)) record.productFlows.push(flow);
      }
      for (const risk of (dev.riskTags || [])) {
        if (!record.riskTags.some((r) => r.id === risk.id)) record.riskTags.push(risk);
      }
      if (run.generatedAt && !record.days.includes(run.generatedAt.slice(0, 10))) {
        record.days.push(run.generatedAt.slice(0, 10));
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

function aggregateDevelopersFromRepoSummaries(repos) {
  const byKey = new Map();
  for (const repo of repos) {
    const repoName = repo.name || "unknown-repo";
    const productFlows = repo.productFlows || [];
    const riskTags = repo.riskTags || [];
    for (const dev of (repo.git?.developers || [])) {
      const key = `${dev.name || "Unknown"} <${dev.email || "unknown"}>`;
      if (!byKey.has(key)) {
        byKey.set(key, { name: dev.name || "Unknown", email: dev.email || "unknown", commits: 0, repos: [], commitSubjects: [], productFlows: [], riskTags: [] });
      }
      const record = byKey.get(key);
      record.commits += (dev.commits || []).length;
      if (!record.repos.includes(repoName)) record.repos.push(repoName);
      for (const commit of (dev.commits || [])) {
        if (commit.subject && !record.commitSubjects.includes(commit.subject)) record.commitSubjects.push(commit.subject);
      }
      for (const flow of productFlows) {
        if (!record.productFlows.some((f) => f.id === flow.id)) record.productFlows.push(flow);
      }
      for (const risk of riskTags) {
        if (!record.riskTags.some((r) => r.id === risk.id)) record.riskTags.push(risk);
      }
    }
  }
  return Array.from(byKey.values());
}

function aggregateAgencyBriefs(runs) {
  const briefsDir = runs.map((run) => run.agencyBriefsPath || run._founderSignals?.agencyBriefsPath || null).find(Boolean) || null;
  const productFlows = new Map();
  const riskTags = new Map();
  for (const run of runs) {
    const signals = run._founderSignals;
    if (!signals) continue;
    for (const repo of (signals.repos || [])) {
      for (const flow of (repo.productFlows || [])) {
        if (!productFlows.has(flow.id)) {
          productFlows.set(flow.id, { ...flow, repos: [repo.name] });
        } else if (!productFlows.get(flow.id).repos.includes(repo.name)) {
          productFlows.get(flow.id).repos.push(repo.name);
        }
      }
      for (const risk of (repo.riskTags || [])) {
        if (!riskTags.has(risk.id)) {
          riskTags.set(risk.id, { ...risk, repos: [repo.name] });
        } else if (!riskTags.get(risk.id).repos.includes(repo.name)) {
          riskTags.get(risk.id).repos.push(repo.name);
        }
      }
    }
  }
  return { briefsDir, productFlows: Array.from(productFlows.values()), riskTags: Array.from(riskTags.values()) };
}

function buildWeeklyMarkdown(runs, devs, aggregated, runIds) {
  const dateRange = runs.length > 0
    ? `${runs[runs.length - 1].generatedAt.slice(0, 10)} to ${runs[0].generatedAt.slice(0, 10)}`
    : "unknown";
  const totalCommits = devs.reduce((s, d) => s + d.commits, 0);
  const repoSet = new Set();
  for (const run of runs) for (const repo of (run.repos || [])) repoSet.add(repo.name || repo);
  const uniqueRepos = Array.from(repoSet).sort();

  const dailyLinks = runIds.map((id) => {
    const d = parseRunDate(id);
    return d ? `- ${d.toISOString().slice(0, 10)} — \`org-sync-reports/${id}/report.md\`` : `- \`org-sync-reports/${id}/report.md\``;
  }).join("\n");

  const devSections = devs.map((d) => `### ${d.name} <${d.email}>

- Total commits: ${d.commits}
- Active days: ${d.days.length}
- Repos: ${d.repos.join(", ")}
- Recent commit subjects:
${d.commitSubjects.map((s) => `  - ${s}`).join("\n")}
- Related product flows: ${d.productFlows.map((f) => `${f.label} (${f.severity})`).join(", ") || "none"}
- Related risk tags: ${d.riskTags.map((t) => `${t.label} (${t.severity})`).join(", ") || "none"}
`).join("\n") || "No developer data found.";

  const flowSection = aggregated.productFlows.map((f) => `- ${f.label} (${f.severity}) — repos: ${f.repos.join(", ")}`).join("\n") || "None detected.";
  const riskSection = aggregated.riskTags.map((t) => `- ${t.label} (${t.severity}) — repos: ${t.repos.join(", ")}`).join("\n") || "None detected.";

  return `# Weekly Summary — ${dateRange}

Generated by \`org-weekly-summary\` from daily org-sync reports. Deterministic mode — no LLM invoked.

## Week Context

- Org root: ${runs.length > 0 ? runs[0].options?.orgRoot || runs[0].orgRoot : "unknown"}
- Date range: ${dateRange}
- Daily reports included: ${runIds.length}
- Unique repos: ${uniqueRepos.length}
- Total commits across all repos: ${totalCommits}
- Unique developers: ${devs.length}

## Daily Reports

${dailyLinks}

## Executive Overview

- Repos with activity: ${uniqueRepos.join(", ") || "none"}
- Product flows touched: ${aggregated.productFlows.length}
- Risk tags: ${aggregated.riskTags.length}
- Developer count: ${devs.length}

## Product Flows Touched (Weekly)

${flowSection}

## Risk Tags (Weekly)

${riskSection}

## Developer-Wise Summary

${devSections}

## Agency Briefs

${aggregated.briefsDir ? `Agency brief artifacts available at: \`${aggregated.briefsDir}\`` : "No agency brief artifacts found in this period."}

## Notes

- This summary is deterministically generated from run-summary.json and founder-signals.json.
- No git commands, no LLM calls.
- For deep reasoning, use agency briefs with an LLM/agent.
`;
}

function buildDeveloperMarkdown(devs) {
  const sections = devs.map((d) => `## ${d.name} <${d.email}>

- Total commits: ${d.commits}
- Active days: ${d.days.length}
- Repos worked on: ${d.repos.join(", ")}
- Commit subjects:
${d.commitSubjects.map((s) => `  - ${s}`).join("\n") || "  - (no commit subjects recorded)"}

### Product Flows

${d.productFlows.map((f) => `- ${f.label} (${f.severity})`).join("\n") || "- None detected."}

### Risk Tags

${d.riskTags.map((t) => `- ${t.label} (${t.severity})`).join("\n") || "- None detected."}
`).join("\n---\n\n") || "No developer data found.";

  return `# Weekly Developer Summary

Generated by \`org-weekly-summary\`. Deterministic — no LLM invoked.

${sections}
`;
}

function buildWeeklyJson(runs, devs, aggregated, runIds) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    orgRoot: runs.length > 0 ? runs[0].options?.orgRoot || runs[0].orgRoot : null,
    dateRange: runs.length > 0
      ? { from: runs[runs.length - 1].generatedAt.slice(0, 10), to: runs[0].generatedAt.slice(0, 10) }
      : null,
    dailyRunCount: runIds.length,
    dailyRunIds: runIds,
    developers: devs,
    productFlows: aggregated.productFlows,
    riskTags: aggregated.riskTags,
    agencyBriefsPath: aggregated.briefsDir,
  };
}

function buildAgencyBriefs(devs, aggregated, runs, runIds) {
  const dateRange = runs.length > 0
    ? `${runs[runs.length - 1].generatedAt.slice(0, 10)} to ${runs[0].generatedAt.slice(0, 10)}`
    : "unknown";
  const orgRoot = runs.length > 0 ? runs[0].options?.orgRoot || runs[0].orgRoot : "unknown";
  const totalCommits = devs.reduce((s, d) => s + d.commits, 0);
  const uniqueRepos = Array.from(new Set(runs.flatMap((r) => (r.repos || []).map((rp) => rp.name || rp)))).sort();

  const repoTable = uniqueRepos.map((r) => `- **${r}**`).join("\n") || "No repos with changes.";
  const devTable = devs.map((d) => `- **${d.name}** <${d.email}>: ${d.commits} commits across [${d.repos.join(", ")}]`).join("\n") || "No developer data.";

  const flowSection = aggregated.productFlows.map((f) => `- ${f.label} (${f.severity})`).join("\n") || "None.";
  const riskSection = aggregated.riskTags.map((t) => `- ${t.label} (${t.severity})`).join("\n") || "None.";

  const dailyLinks = runIds.map((id) => `- \`org-sync-reports/${id}/report.md\``).join("\n");

  function briefContext(domain, questions) {
    return `
## Run Context

- Org root: ${orgRoot}
- Date range: ${dateRange}
- Daily runs: ${runIds.length}
- Domain: ${domain}

## Changed Repositories

${repoTable}

## Product Flows Touched

${flowSection}

## Risk Tags

${riskSection}

## Developer-Wise Changes

${devTable}

## Daily Reports

${dailyLinks}

## Domain-Specific Questions

${questions}

## Guardrails

- Base analysis **only** on the evidence above.
- Flag uncertainties explicitly as "not enough evidence."
- Do not speculate on business impact, revenue, or customer sentiment unless explicitly stated.
- Do not generate code, patches, or implementation plans unless asked.
- If critical information is missing, state what is needed rather than filling gaps with assumptions.
`;
  }

  return {
    "product.md": `# Weekly Agency Brief: Product\n\n${briefContext("Product", `- Which product flows had the most activity this week?
- Are there cumulative risks from multiple repos touching the same flow?
- What should be the product focus for the coming week?
- Which features need QA or testing based on changed areas?`)}`,
    "gtm.md": `# Weekly Agency Brief: GTM\n\n${briefContext("GTM", `- What weekly product changes strengthen the GTM narrative?
- Which changes unblock new customer conversations?
- What should be highlighted in investor or stakeholder updates?`)}`,
    "sales.md": `# Weekly Agency Brief: Sales\n\n${briefContext("Sales", `- Which weekly changes create new demo stories or close objections?
- Are any changes risky to sell before further validation?
- What pipeline deals could be moved forward based on this week's evidence?`)}`,
    "marketing.md": `# Weekly Agency Brief: Marketing\n\n${briefContext("Marketing", `- What weekly content narratives can be built from this evidence?
- Which proof points became stronger this week?
- What social/community updates are warranted?`)}`,
    "engineering.md": `# Weekly Agency Brief: Engineering\n\n${briefContext("Engineering", `- What are the cumulative technical risks across the week?
- Which repos need prioritized code review or testing?
- Are there architectural concerns from cross-repo changes?
- What should the engineering focus be for the coming week?`)}

## Developer Details

${devs.map((d) => `### ${d.name} <${d.email}>
- Commits: ${d.commits}
- Active days: ${d.days.length}
- Repos: ${d.repos.join(", ")}
- Subjects:
${d.commitSubjects.map((s) => `  - ${s}`).join("\n")}
- Product flows: ${d.productFlows.map((f) => `${f.label} (${f.severity})`).join(", ") || "none"}
- Risk tags: ${d.riskTags.map((t) => `${t.label} (${t.severity})`).join(", ") || "none"}
`).join("\n") || "No developer data found."}
`,
    "customer-success.md": `# Weekly Agency Brief: Customer Success\n\n${briefContext("Customer Success", `- What cumulative changes affect the customer experience this week?
- Are there migration, deprecation, or behavior-change patterns across repos?
- What should support teams be briefed on?`)}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.orgRoot) throw new Error("--org-root is required");
  const orgStats = await import("node:fs").then((fs) => fs.statSync(options.orgRoot, { throwIfNoEntry: false }));
  if (!orgStats?.isDirectory()) throw new Error(`Org root does not exist: ${options.orgRoot}`);

  const runIds = await discoverReportRuns(options.orgRoot);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - options.sinceDays);

  const runs = [];
  const filteredRunIds = [];
  for (const runId of runIds) {
    const runDate = parseRunDate(runId);
    if (!runDate) continue;
    if (runDate < cutoff) continue;

    const summary = await readJsonIfExists(path.join(options.orgRoot, "org-sync-reports", runId, "run-summary.json"));
    if (!summary) continue;
    const signals = await readJsonIfExists(path.join(options.orgRoot, "org-sync-reports", runId, "founder-signals.json"));
    summary._founderSignals = signals;
    runs.push(summary);
    filteredRunIds.push(runId);
  }

  if (runs.length === 0) {
    console.log(`No org-sync reports found in the last ${options.sinceDays} days under ${options.orgRoot}`);
    return;
  }

  const now = new Date();
  const timestamp = timestampForPath(now);
  const outputDir = options.outputDir || path.join(options.orgRoot, "org-sync-weekly", timestamp);
  const yyyyMmDd = now.toISOString().slice(0, 10);
  const { year, month } = dateParts(yyyyMmDd);

  const devs = aggregateDevelopersFromRuns(runs);
  const aggregated = aggregateAgencyBriefs(runs);

  if (options.dryRun) {
    console.log(`Org root: ${options.orgRoot}`);
    console.log(`Since days: ${options.sinceDays}`);
    console.log(`Reports found: ${runs.length}`);
    console.log(`Run IDs: ${filteredRunIds.join(", ")}`);
    console.log(`Output dir: ${outputDir}`);
    console.log(`Developers found: ${devs.length}`);
    console.log("Dry run only. Planned artifacts:");
    console.log(`  - ${outputDir}/weekly-summary.md`);
    console.log(`  - ${outputDir}/weekly-summary.json`);
    console.log(`  - ${outputDir}/developer-summary.md`);
    console.log(`  - ${outputDir}/agency-briefs/index.json`);
    console.log(`  - ${outputDir}/agency-briefs/product.md`);
    console.log(`  - ${outputDir}/agency-briefs/gtm.md`);
    console.log(`  - ${outputDir}/agency-briefs/sales.md`);
    console.log(`  - ${outputDir}/agency-briefs/marketing.md`);
    console.log(`  - ${outputDir}/agency-briefs/engineering.md`);
    console.log(`  - ${outputDir}/agency-briefs/customer-success.md`);
    console.log(`  - vision/weekly-analysis-${yyyyMmDd}.md if missing, otherwise vision/weekly-summary-${yyyyMmDd}.md`);
    console.log(`  - vision/weekly/${year}/${month}/weekly-${yyyyMmDd}.md`);
    return;
  }

  await mkdir(outputDir, { recursive: true });
  await mkdir(path.join(outputDir, "agency-briefs"), { recursive: true });

  const weeklyMd = buildWeeklyMarkdown(runs, devs, aggregated, filteredRunIds);
  const weeklyJson = buildWeeklyJson(runs, devs, aggregated, filteredRunIds);
  const devMd = buildDeveloperMarkdown(devs);

  await writeFile(path.join(outputDir, "weekly-summary.md"), weeklyMd, "utf8");
  await writeJson(path.join(outputDir, "weekly-summary.json"), weeklyJson);
  await writeFile(path.join(outputDir, "developer-summary.md"), devMd, "utf8");

  const agencyIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    briefs: [
      { id: "product", label: "Product", file: "product.md", description: "Weekly product strategy evidence" },
      { id: "gtm", label: "GTM", file: "gtm.md", description: "Weekly GTM strategy evidence" },
      { id: "sales", label: "Sales", file: "sales.md", description: "Weekly sales enablement evidence" },
      { id: "marketing", label: "Marketing", file: "marketing.md", description: "Weekly marketing strategy evidence" },
      { id: "engineering", label: "Engineering", file: "engineering.md", description: "Weekly technical risk and developer review" },
      { id: "customer-success", label: "Customer Success", file: "customer-success.md", description: "Weekly customer impact evidence" },
    ],
  };
  await writeJson(path.join(outputDir, "agency-briefs", "index.json"), agencyIndex);

  const weeklyBriefs = buildAgencyBriefs(devs, aggregated, runs, filteredRunIds);
  for (const [fileName, content] of Object.entries(weeklyBriefs)) {
    await writeFile(path.join(outputDir, "agency-briefs", fileName), content, "utf8");
  }

  const visionDir = path.join(options.orgRoot, "vision");
  await mkdir(visionDir, { recursive: true });

  const preferredVisionWeeklyPath = path.join(visionDir, `weekly-analysis-${yyyyMmDd}.md`);
  const visionWeeklyPath = existsSync(preferredVisionWeeklyPath)
    ? path.join(visionDir, `weekly-summary-${yyyyMmDd}.md`)
    : preferredVisionWeeklyPath;
  await writeFile(visionWeeklyPath, weeklyMd, "utf8");

  const visionArchiveDir = path.join(visionDir, "weekly", year, month);
  await mkdir(visionArchiveDir, { recursive: true });
  const archiveMdPath = path.join(visionArchiveDir, `weekly-${yyyyMmDd}.md`);
  await writeFile(archiveMdPath, weeklyMd, "utf8");

  console.log(`Weekly summary written: ${outputDir}`);
  console.log(`Vision weekly analysis: ${visionWeeklyPath}`);
  console.log(`Vision weekly archive: ${archiveMdPath}`);
  console.log(`Daily reports aggregated: ${filteredRunIds.length}`);
  console.log(`Developers: ${devs.length}`);
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(`org-weekly-summary failed: ${error.message}`);
  process.exitCode = 1;
});
