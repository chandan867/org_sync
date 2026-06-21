# org-sync-tools

Founder intelligence layer for multi-repo orgs. Run it from any folder containing `*_org` directories and it produces structured, business-readable reports, agency briefs, a local dashboard, and a daily founder briefing — without a hardcoded path anywhere.

## What it does

You have one or more products, each with several Git repos. You want to know — in plain language — what changed since yesterday, which product flows were touched, what can be demoed today, and what needs a decision before shipping.

`org-sync-tools` answers those questions by:

1. Scanning every `*_org` folder under your projects root
2. Pulling the latest changes (optional) and collecting structured Git metadata
3. Running GitNexus structural analysis on each repo
4. Mapping file-level changes to **product flows** and **risk signals** with confidence scores
5. Generating a founder-facing briefing via OpenCode (or a structured fallback without it)
6. Writing per-domain **agency briefs** (Product, GTM, Sales, Marketing, Engineering, Customer Success)
7. Writing **founder notes** — daily digest, decisions log, todos, GTM experiments — via `vision/`
8. Serving everything through a local read-only **dashboard** at `http://localhost:3877`

## Workspace shape

The tool discovers `*_org` folders automatically from wherever you run it:

```text
~/projects/
  upandup_org/
    mobile-app/        ← git repo
    backend/           ← git repo
    frontend/          ← git repo
    vision/            ← founder notes (goals, todos, daily, GTM)
  zynd_org/
    api/
    web/
    vision/
  org-sync-tools/      ← this repo
```

No path is hardcoded. The default projects root is `process.cwd()` — just `cd` to your projects folder before running, or set `ORG_SYNC_PROJECTS_ROOT`.

## Requirements

- Node.js 18+
- git
- [OpenCode](https://opencode.ai) CLI — for LLM synthesis (optional; `--no-llm` skips it)
- [GitNexus](https://gitnexus.dev) — for structural impact analysis (optional; `--no-gitnexus` skips it)
- macOS — only for the LaunchAgent auto-run feature

## Install

```bash
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
founder-sync --help
```

## Quick start

```bash
# from your projects folder (the one containing *_org dirs)
cd ~/projects

# one-shot sync for a single org (no pull, no LLM, fast)
org-sync-all --include upandup_org --org-args '--no-pull --no-llm'

# open the dashboard
org-dashboard &
open http://localhost:3877
```

## Daily workflow

```bash
cd ~/projects
org-sync-all
```

This runs for every `*_org` folder:
1. `org-sync` — collects git changes, tags product flows and risk signals, runs GitNexus, invokes OpenCode for a founder report
2. `founder-sync` — reads the org-sync output and your `vision/` context, writes daily note / decisions / todos via OpenCode

## Configuration

### Projects root

Precedence order (highest first):

| Method | Example |
|--------|---------|
| `--projects-root` CLI flag | `org-sync-all --projects-root ~/projects` |
| `ORG_SYNC_PROJECTS_ROOT` env var | `export ORG_SYNC_PROJECTS_ROOT=~/projects` |
| Current working directory | `cd ~/projects && org-sync-all` |

Set it permanently in your shell profile:

```bash
export ORG_SYNC_PROJECTS_ROOT="$HOME/projects"
```

### Per-org product rules

By default, generic product-flow rules cover auth/onboarding, payments, core user flow, notifications, data/export, integrations, and admin/settings.

To customize for your product, add fenced JSON blocks to `<org>/vision/product-overview.md`:

````markdown
```org-sync:product-flows
[
  { "id": "worker-checkin", "label": "Worker Check-in", "severity": "critical",
    "pathPatterns": ["checkin", "attendance", "geofence", "faceverif"],
    "textPatterns": ["check.?in", "attendance", "geofence"] },
  { "id": "shift-replacement", "label": "Shift Replacement", "severity": "critical",
    "pathPatterns": ["replacement", "shift"],
    "textPatterns": ["replacement", "fill shift"] }
]
```

```org-sync:risk-rules
[
  { "id": "schema-migration", "label": "DB Schema / Prisma Migration", "severity": "high",
    "pathPatterns": ["migration", "prisma", "entity"],
    "textPatterns": ["migration", "schema change"] }
]
```

```org-sync:domain
{ "label": "Workforce Management / PSA" }
```
````

If the blocks are absent or unparseable, generic defaults are used — no breakage.

### GitNexus

GitNexus runs structural impact analysis (`gitnexus status`) on each repo automatically if a local runner exists at `.gitnexus/run.cjs`, or via `npx gitnexus` as a fallback.

When OpenCode synthesises the org report, it can also call GitNexus MCP tools (`gitnexus impact`, `gitnexus detect_changes`) for blast-radius analysis. No extra config needed — OpenCode picks them up from its tool context.

Skip GitNexus entirely:

```bash
org-sync --no-gitnexus
```

## Commands

### `org-sync-all` — daily multi-org sync

```bash
# all orgs, defaults
org-sync-all

# one org, no remote pull
org-sync-all --include upandup_org --org-args '--no-pull'

# local-only, no OpenCode
org-sync-all --org-args '--no-pull --no-llm' --founder-args '--no-llm'

# also run weekly summary after daily
org-sync-all --weekly

# dry run (prints plan, writes nothing)
org-sync-all --dry-run
```

### `org-sync` — single org

```bash
# from inside or pointing at an org root
org-sync --org-root ~/projects/upandup_org --since "24 hours ago"

# compare against a specific git ref
org-sync --org-root ~/projects/upandup_org --baseline main

# skip LLM, get deterministic structured report with traffic-light table
org-sync --org-root ~/projects/upandup_org --no-llm

# also write deep-review and release-readiness prompts
org-sync --org-root ~/projects/upandup_org --deep --release
```

### `founder-sync` — founder strategy layer

```bash
founder-sync --org-root ~/projects/upandup_org

# with research synthesis
founder-sync --org-root ~/projects/upandup_org --research

# local-only (no OpenCode)
founder-sync --org-root ~/projects/upandup_org --no-llm
```

### `org-dashboard` — local dashboard

```bash
org-dashboard
# → http://localhost:3877

# explicit projects root
org-dashboard --projects-root ~/projects
```

### `org-weekly-summary` — weekly rollup

```bash
org-weekly-summary --org-root ~/projects/upandup_org

# custom window
org-weekly-summary --org-root ~/projects/upandup_org --since-days 14
```

### Auto-run on macOS

```bash
# install once-per-day LaunchAgent
npm run org:auto:install

# preview what will be installed
npm run org:auto:install -- --dry-run

# force a run now
npm run org:auto:run -- --force

# uninstall
npm run org:auto:uninstall
```

## What you get

### Report quality

The no-LLM (`--no-llm`) fallback produces a **structured markdown report** with:

- Traffic-light table (🔴 HIGH / 🟡 MEDIUM / 🟢 LOW) per repo
- Product flows touched with **confidence scores** (0–100%) based on path hits, text matches, and derived signals
- Risk signals table (schema changes, API contracts, auth, geofence, infra, etc.)
- Commit list grouped by developer

The LLM report (default) uses that structured data as context and returns:
- **Executive Read** — one paragraph on what matters most
- **What Changed (Product Lens)** — user-facing impact, not file lists
- **Demo & Sales Readiness** — what can be shown, what can't, and why
- **Business Risks & Blockers** — what needs a founder decision
- **Engineering Health** — who did what, risk level, GitNexus findings
- **Recommended Moves (Top 3)**
- **Open Questions for Founder**

### Agency briefs

Six Markdown files per run under `agency-briefs/`: `product.md`, `gtm.md`, `sales.md`, `marketing.md`, `engineering.md`, `customer-success.md`. Each contains structured evidence and domain-specific questions for that function.

### Vision / founder hub

`vision/` folder written by `founder-sync`:

```text
vision/
  goals.md
  todos.md
  founder-input.md
  gtm-experiments.md
  daily/YYYY/MM/YYYY-MM-DD.md
  decisions/YYYY/MM/YYYY-MM-DD.md
  research/YYYY/MM/YYYY-MM-DD.md
```

### Dashboard

The dashboard reads all generated artifacts — no git, no LLM calls, no syncs. Highlights:

- **Home**: cross-org aggregate metrics (repos changed, critical flows, high-risk, deep review needed)
- **Org page**: Today's Briefing digest (reads Executive Read + What Changed + Recommended Moves from the latest founder daily note inline), agency brief question previews, signal rows, founder hub links
- **Project page**: per-repo git summary, product flows, risk signals, diff excerpt
- **Runs selector**: browse canonical daily runs or all runs

## Generated artifacts

```text
<org-root>/
  org-sync-reports/<timestamp>/
    report.md                  # founder or fallback report
    run-summary.json           # full structured data
    founder-signals.json       # product flows, risk tags, developers
    org-prompt.md              # LLM prompt (for manual re-use)
    deep-review-prompt.md      # (with --deep)
    release-review-prompt.md   # (with --release)
    agency-briefs/
      product.md  gtm.md  sales.md  marketing.md  engineering.md  customer-success.md
    repos/<repo>/
      git-summary.md
      llm-prompt.md
      summary.json
  org-sync-weekly/<timestamp>/
    weekly-summary.md
    developer-summary.md
    agency-briefs/
  org-sync-notes/              # Obsidian-compatible Markdown notes
  vision/                      # founder hub (goals, todos, daily, etc.)

<projects-root>/
  .org-intel-global/           # dashboard index, cross-org state
```

> Generated artifacts may contain code excerpts, diffs, paths, product strategy, and founder notes. Review before committing or sharing.

## Project layout

```text
scripts/
  lib/org-config.mjs           # shared config: path resolution, default rules, noise filter
  org-sync.mjs                 # per-org daily engineering sync
  founder-sync.mjs             # founder/product strategy layer
  org-sync-all.mjs             # multi-org orchestrator
  org-weekly-summary.mjs       # weekly developer/product rollup
  org-dashboard.mjs            # read-only localhost dashboard
  org-sync-cleanup.mjs         # duplicate run cleanup
  org-sync-auto-runner.mjs     # once-per-day runner (used by LaunchAgent)
  org-sync-auto-install.mjs    # macOS LaunchAgent install
  org-sync-auto-uninstall.mjs  # macOS LaunchAgent uninstall
ORG_SYNC_GUIDE.md              # detailed operating guide
SETUP.md                       # step-by-step first-time setup
```

## Troubleshooting

**`org-sync` command not found** — run `npm link` again, then `hash -r`.

**No repos found** — check that `*_org` folders contain immediate child directories with `.git`.

**No orgs found** — make sure you're running from the projects root or have `ORG_SYNC_PROJECTS_ROOT` set.

**OpenCode fails** — run `opencode --help` to verify it's installed. Use `--no-llm` for local-only output.

**Dashboard has no data** — run a sync first (`org-sync-all --include <org>`), then restart the dashboard.

**Auto-run logs** — check `<projects-root>/.org-intel-global/logs/` and `launchd.out.log` / `launchd.err.log`.
