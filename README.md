# org-sync-tools

Founder intelligence layer for multi-repo orgs. Produces business-readable reports, LLM-synthesized agency briefs, and a local dashboard — no hardcoded paths.

## What it does

You have one or more products, each with several Git repos. You want to know — in plain language — what changed since yesterday, which product flows were touched, what can be demoed today, and what needs a decision before shipping.

`org-sync-tools` answers those questions by:

1. Scanning every `*_org` folder under your projects root
2. Collecting structured Git metadata (commits, diffs, untracked changes)
3. Running GitNexus structural analysis on each repo
4. Mapping file-level changes to **product flows** and **risk signals** with confidence scores (0–100%)
5. Generating a founder-facing briefing via OpenCode
6. Generating **LLM-synthesized agency briefs** for Product, GTM, Sales, Marketing, Engineering, and Customer Success
7. Writing **founder notes** (daily digest, decisions, todos, GTM experiments) via `vision/`
8. Serving everything through a local read-only **dashboard** at `http://localhost:3877`

## Workspace shape

```text
~/projects/
  upandup_org/
    mobile-app/        ← git repo
    backend/           ← git repo
    vision/            ← founder notes (goals, todos, daily, GTM)
  zynd_org/
    api/
    web/
    vision/
  org-sync-tools/      ← this repo
```

The default projects root is `process.cwd()`. No path is hardcoded anywhere.

## Requirements

- Node.js 18+
- git
- [OpenCode](https://opencode.ai) CLI — for LLM reports and briefs (use `--no-llm` to skip)
- [GitNexus](https://gitnexus.dev) — for structural impact analysis (use `--no-gitnexus` to skip)
- macOS — only for the LaunchAgent auto-run feature

## Install

```bash
cd ~/projects   # your projects folder
git clone https://github.com/chandan867/org_sync.git org-sync-tools
cd org-sync-tools
npm install
npm link
```

Verify:

```bash
org-sync --help
org-sync-all --help
org-dashboard --help
```

## Daily usage

```bash
cd ~/projects
org-sync-all               # sync all *_org folders
org-dashboard &            # start dashboard
open http://localhost:3877
```

That's it. `org-sync-all` runs both `org-sync` and `founder-sync` for every org, then the dashboard serves everything.

## Projects root

| Method | Example |
|--------|---------|
| `--projects-root` flag | `org-sync-all --projects-root ~/projects` |
| `ORG_SYNC_PROJECTS_ROOT` env var | `export ORG_SYNC_PROJECTS_ROOT=~/projects` |
| Current working directory | `cd ~/projects && org-sync-all` |

## Per-org product rules

By default, generic rules cover auth, payments, core user flow, notifications, and integrations. Add custom rules per org for better signal quality.

Create `<org>/vision/product-overview.md` with fenced blocks:

````markdown
```org-sync:product-flows
[
  { "id": "worker-checkin", "label": "Worker Check-in", "severity": "critical",
    "pathPatterns": ["checkin", "attendance", "geofence"],
    "textPatterns": ["check.?in", "attendance", "geofence"] }
]
```

```org-sync:risk-rules
[
  { "id": "schema-migration", "label": "DB Schema Migration", "severity": "high",
    "pathPatterns": ["migration", "prisma"],
    "textPatterns": ["migration", "schema change"] }
]
```

```org-sync:domain
{ "label": "Workforce Management / PSA" }
```
````

Rules are case-insensitive regex patterns. If blocks are absent, generic defaults are used.

## Commands

### `org-sync-all` — daily multi-org sync

```bash
org-sync-all                                              # all orgs
org-sync-all --include upandup_org                        # one org
org-sync-all --org-args '--no-pull'                       # skip git pull
org-sync-all --org-args '--no-pull --no-llm'             # no OpenCode
org-sync-all --weekly                                     # also run weekly summary
org-sync-all --dry-run                                    # print plan, write nothing
```

### `org-sync` — single org

```bash
org-sync --org-root ~/projects/upandup_org
org-sync --org-root ~/projects/upandup_org --since "48 hours ago"
org-sync --org-root ~/projects/upandup_org --baseline main
org-sync --org-root ~/projects/upandup_org --no-llm
```

### `org-dashboard` — local dashboard

```bash
org-dashboard                              # uses cwd as projects root
org-dashboard --projects-root ~/projects
```

Dashboard is read-only. Never calls git, LLM, or external services.

### `founder-sync` — founder strategy layer

```bash
founder-sync --org-root ~/projects/upandup_org
founder-sync --org-root ~/projects/upandup_org --no-llm
```

### `org-weekly-summary` — weekly rollup

```bash
org-weekly-summary --org-root ~/projects/upandup_org
org-weekly-summary --org-root ~/projects/upandup_org --since-days 14
```

## What you get

### Founder report (`report.md`)

When OpenCode runs (default), the report contains:
- **Executive Read** — one paragraph on what matters most
- **What Changed (Product Lens)** — user-facing impact, not file lists
- **Demo & Sales Readiness** — what can be shown, what can't, and why
- **Business Risks & Blockers** — what needs a founder decision
- **Engineering Health** — who did what, risk level, GitNexus findings
- **Recommended Moves (Top 3)**
- **Open Questions for Founder**

Without OpenCode (`--no-llm`), you get a structured markdown report with a traffic-light table (🔴/🟡/🟢) and confidence-scored flow/risk tables.

### Agency briefs

Six files per run under `agency-briefs/`: `product.md`, `gtm.md`, `sales.md`, `marketing.md`, `engineering.md`, `customer-success.md`.

When OpenCode runs, each brief is **fully synthesized by the LLM** — it acts as the relevant domain head (Head of Product, Head of GTM, Engineering Lead, etc.) and produces an actionable brief with tables, checklists, and specific recommendations. Without OpenCode, briefs contain structured evidence with a note to re-run with LLM.

### Dashboard

- **Home** — cross-org metrics (repos changed, critical flows, high-risk repos, deep review needed)
- **Org page** — today's briefing digest, agency brief links, product flow and risk signal rows, founder hub links
- **Project page** — per-repo git summary, product flows, risk signals, diff excerpt
- **Run selector** — canonical daily runs (prefers LLM-completed, latest first) or all runs

### Vision / founder hub

Written by `founder-sync` under `vision/`:

```text
vision/
  goals.md
  todos.md
  founder-input.md
  gtm-experiments.md
  daily/YYYY/MM/YYYY-MM-DD.md
  decisions/YYYY/MM/YYYY-MM-DD.md
```

## Generated artifacts

```text
<org-root>/
  org-sync-reports/<timestamp>/
    report.md
    run-summary.json
    founder-signals.json
    org-prompt.md
    agency-briefs/
      product.md  gtm.md  sales.md  marketing.md  engineering.md  customer-success.md
    repos/<repo>/
      git-summary.md  llm-prompt.md  summary.json
  org-sync-weekly/<timestamp>/
    weekly-summary.md  developer-summary.md
  org-sync-notes/        ← Obsidian-compatible notes
  vision/                ← founder hub

<projects-root>/
  .org-intel-global/     ← dashboard index, cross-org state
```

> Artifacts may contain code, diffs, product strategy, and founder notes. Do not commit them.

## Project layout

```text
scripts/
  lib/org-config.mjs           ← shared config: path resolution, rules, noise filter
  org-sync.mjs                 ← per-org daily sync
  founder-sync.mjs             ← founder/product strategy layer
  org-sync-all.mjs             ← multi-org orchestrator
  org-weekly-summary.mjs       ← weekly rollup
  org-dashboard.mjs            ← read-only dashboard
  org-sync-cleanup.mjs         ← remove duplicate runs
  org-sync-auto-runner.mjs     ← once-per-day runner (LaunchAgent)
  org-sync-auto-install.mjs    ← macOS LaunchAgent install
  org-sync-auto-uninstall.mjs  ← macOS LaunchAgent uninstall
SETUP.md                       ← first-time setup guide
```

## Troubleshooting

**`org-sync` not found** — run `npm link` then `hash -r`

**No repos found** — repos must be immediate children of the `*_org` folder with `.git`

**No orgs found** — run from the projects root, or set `ORG_SYNC_PROJECTS_ROOT`

**OpenCode fails** — run `opencode --help` to verify installation; use `--no-llm` to skip

**Dashboard shows no data** — run `org-sync-all` first, then restart the dashboard

**Dashboard shows old run** — the dashboard picks the latest LLM-completed run automatically; if you see a stale run, check that `run-summary.json` exists in the latest run directory
