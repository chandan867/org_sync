# Org Sync Guide

Use `org-sync` when you open your laptop and want a morning report for a folder that contains multiple Git repos.

This tool lives outside individual app repos at:

```text
/Users/chandan/Desktop/projects/org-sync-tools
```

That makes it available from any org/project folder under:

```text
/Users/chandan/Desktop/projects
```

For multi-org automation, only folders ending in `_org` are treated as sync targets, for example:

```text
/Users/chandan/Desktop/projects/upandup_org
/Users/chandan/Desktop/projects/zynd_org
```

The script is generic: run it from **any org folder** such as:

```bash
/Users/chandan/Desktop/projects/upandup_org
/Users/chandan/Desktop/projects/zynd_org
```

It discovers immediate child Git repos, optionally pulls latest changes, collects recent Git changes, groups commits developer-wise, checks GitNexus status, writes raw report artifacts, and writes Obsidian-friendly Markdown notes.

## One-time setup

From the project-level tool folder:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm install
npm link
```

After `npm link`, the command `org-sync` should be available from any terminal folder.

Check:

```bash
org-sync --help
```

## Daily commands

### Multi-org daily sync

Run this from anywhere to sync every `*_org` folder under `/Users/chandan/Desktop/projects`:

```bash
org-sync-all
```

Default behavior per org:

```bash
org-sync --since "1 day ago" --no-pull
founder-sync
```

LLM intelligence is part of the normal SOP. `org-sync` and `founder-sync` invoke OpenCode by default. Use explicit `--no-llm` args only when you need a local-only deterministic fallback.

Preview without writing reports:

```bash
org-sync-all --dry-run
```

Include or exclude orgs:

```bash
org-sync-all --include upandup_org
org-sync-all --exclude zynd_org
```

The global multi-org index is written to:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
```

### Local dashboard

Start the read-only local dashboard:

```bash
org-dashboard
```

Then open:

```text
http://localhost:3877
```

The dashboard reads the global index and per-org signals. It does not run syncs on startup, so it opens quickly. Daily sync is handled by `org-sync-all` / auto-run.

### 1. Preview what will run

Run this first if you want to verify the folder and repos:

```bash
cd /Users/chandan/Desktop/projects/upandup_org
org-sync --dry-run
```

### 2. Normal morning sync report

From any folder that contains multiple repos:

```bash
org-sync
```

Then run the founder/strategy layer:

```bash
founder-sync
```

For deeper strategic research:

```bash
founder-sync --research
```

This uses the normal intelligence-first defaults:

- pulls only clean repos
- skips dirty repos instead of risking local work
- runs GitNexus `status`, not `analyze`
- invokes OpenCode/LLM by default for before/after reasoning and founder intelligence
- can be made local-only with `--no-llm`
- writes raw reports to:

```bash
org-sync-reports/<timestamp>/report.md
```

- writes Obsidian notes to:

```bash
org-sync-notes/YYYY/MM/YYYY-MM-DD.md
```

### 3. Run for one repo only

```bash
org-sync --repo GuardManagementV2
```

You can repeat `--repo`:

```bash
org-sync --repo GuardManagementV2 --repo another-repo
```

### 4. Skip pulling

Use this when you only want a local report:

```bash
org-sync --no-pull
```

### 5. Disable OpenCode reasoning

OpenCode is enabled by default. Use this only when you want local-only deterministic reports:

```bash
org-sync --no-llm
```

Note: OpenCode may send prompt content according to your provider configuration. Use `--no-llm` when that is not acceptable.

### 6. Run GitNexus analyze explicitly

By default, the script only runs GitNexus `status`. To re-index repos first:

```bash
org-sync --gitnexus-analyze
```

Use this intentionally because GitNexus analyze may update generated GitNexus/agent instruction files.

### 7. Pull dirty repos anyway

By default, dirty repos are not pulled. If you explicitly want to allow pulls with local changes:

```bash
org-sync --allow-dirty-pull
```

### 8. Use a custom Obsidian notes folder

By default, notes go to `org-sync-notes/` inside the org folder. To point notes at another Markdown-only folder:

```bash
org-sync --notes-dir /path/to/Obsidian/OrgSync
```

Disable Obsidian notes entirely:

```bash
org-sync --no-notes
```

## Useful examples

Safe morning run for `upandup_org`:

```bash
cd /Users/chandan/Desktop/projects/upandup_org
org-sync
```

Preview a different org folder:

```bash
cd /Users/chandan/Desktop/projects/zynd_org
org-sync --dry-run
```

Generate an OpenCode-assisted report without pulling:

```bash
org-sync --no-pull
```

Compare against a baseline branch/ref:

```bash
org-sync --baseline main
```

Use a custom time window:

```bash
org-sync --since "48 hours ago"
```

Run the full morning flow:

```bash
cd /Users/chandan/Desktop/projects/upandup_org
org-sync --since "1 day ago"
founder-sync --research
```

Run a deeper technical/product-risk review prompt:

```bash
org-sync --since "1 day ago" --no-pull --deep
```

Run release-readiness prompt generation:

```bash
org-sync --baseline main --no-pull --deep --release
```

`--deep` and `--release` do not call MCP/GitNexus impact tools directly. They generate structured prompts and founder signals from available Git/GitNexus CLI evidence so an assistant with MCP access can run deeper impact analysis when needed.

## Automatic daily sync on macOS

You can install a macOS LaunchAgent so the machine runs `org-sync-all` automatically once per local calendar day after login/wake availability.

Manual commands still work any time. The automatic runner only adds a once-per-day background run.

### Install automatic sync

From this tool repo:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm run org:auto:install
```

The LaunchAgent:

- runs at login,
- checks again every 30 minutes while macOS is awake,
- runs across every `*_org` folder under `/Users/chandan/Desktop/projects`,
- exits immediately if today already completed successfully,
- writes logs/stamps under:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
```

Default automatic behavior is intelligence-first and no-pull:

```bash
org-sync --since "1 day ago" --no-pull
founder-sync
```

That means the auto-run uses only local git history, does **not** pull remote changes, and **does invoke OpenCode/LLM by default**. LLM intelligence is considered critical to the daily founder/product flow.

Remote pulls and research are opt-in. Local-only deterministic mode is opt-out with `--no-llm`.

### Add research or opt out of LLM in automatic mode

If you want the automatic first-open flow to also include founder research output:

```bash
npm run org:auto:install -- \
  --founder-args '--research'
```

If you need a local-only automatic fallback with no OpenCode calls:

```bash
npm run org:auto:install -- \
  --org-args '--since "1 day ago" --no-pull --no-llm' \
  --founder-args '--no-llm'
```

To also allow remote pulls in the auto run, drop `--no-pull` from `--org-args`.

This may send prompt content according to your OpenCode provider configuration.

### Preview automatic setup

```bash
npm run org:auto:install -- --dry-run
```

Preview the daily runner without writing state or running syncs:

```bash
npm run org:auto:run -- --dry-run
```

Force a manual auto-run even if today already has a success stamp:

```bash
npm run org:auto:run -- --force
```

### Change interval or org folder

Check every 15 minutes instead of 30:

```bash
npm run org:auto:install -- --interval 900
```

Use a different projects root:

```bash
npm run org:auto:install -- --projects-root /Users/chandan/Desktop/projects
```

### Uninstall automatic sync

```bash
npm run org:auto:uninstall
```

Remove logs/stamps too:

```bash
npm run org:auto:uninstall -- --purge-state
```

### Notes about laptop open timing

macOS LaunchAgents do not run while the laptop is asleep. The agent runs at login and then on the configured interval once macOS is awake. The once-per-day runner is what guarantees this only completes once per day.

## Founder Sync

`founder-sync` is the co-founder/strategy layer that runs after `org-sync`.

It reads:

- latest `org-sync-reports/<timestamp>/report.md`
- sibling `org-sync-reports/<timestamp>/founder-signals.json` when available
- `vision/goals.md`
- `vision/questions.md`
- `vision/founder-input.md`
- `vision/gtm-experiments.md`
- existing `vision/todos.md`
- previous 7 days of `vision/daily/...`
- previous 7 days of `vision/decisions/...`
- previous 7 days of `vision/research/...` when present
- selected agency agents from `/Users/chandan/Desktop/projects/agency-agents`

It writes Markdown-only strategy outputs into `vision/`:

```text
vision/
  goals.md
  questions.md
  founder-input.md
  gtm-experiments.md
  todos.md
  daily/YYYY/MM/YYYY-MM-DD.md
  decisions/YYYY/MM/YYYY-MM-DD.md
  research/YYYY/MM/YYYY-MM-DD.md
```

### First run

If `vision/goals.md`, `vision/questions.md`, or `vision/founder-input.md` is missing, `founder-sync` creates templates and stops.

It also creates `vision/gtm-experiments.md` on first run if missing.

Fill these files before rerunning:

```text
vision/goals.md
vision/founder-input.md
vision/gtm-experiments.md
```

This keeps the strategy benchmarked against measurable goals and grounded in your real sales calls, customer feedback, learnings, and hurdles.

### Goals / benchmarks

`vision/goals.md` is the benchmark source for every founder sync. Put measurable targets here, such as:

- 10,000 users
- 2,000 paid customers
- revenue targets
- launch date
- launch market
- sales/GTM targets
- product readiness goals
- operational constraints or non-goals

Every generated strategy note should be judged against these goals.

### Continuity behavior

`founder-sync` reconciles the previous 7 days of founder notes and the current `vision/todos.md`.

Unfinished todos, blockers, learnings, research questions, and GTM needs should continue to appear in generated todos until they are:

- completed,
- explicitly deprioritized,
- or replaced with a better next action and rationale.

This prevents important work from disappearing just because a day changed.

### GTM channel checklist

The founder-sync prompt explicitly asks the strategy layer to consider all major GTM/marketing channels against `vision/goals.md`. It should not force actions for every channel, but it should think through:

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

### GTM experiment ledger

`founder-sync` maintains a generated block inside:

```text
vision/gtm-experiments.md
```

Use it as the running ledger for:

- active experiments,
- proposed channel tests,
- completed learnings,
- paused/rejected experiments with rationale.

Todos should contain next actions. The experiment ledger should contain the hypothesis, channel, success metric, and learning history.

### Founder Sync commands

Normal strategy review:

```bash
founder-sync
```

With research questions/output:

```bash
founder-sync --research
```

Dry run:

```bash
founder-sync --dry-run
```

Local-only fallback without OpenCode:

```bash
founder-sync --no-llm
```

Use a different agency agents folder:

```bash
founder-sync --agents-root /path/to/agency-agents
```

Use a specific org-sync report:

```bash
founder-sync --org-sync-report org-sync-reports/<timestamp>/report.md
```

### Founder Sync outputs

Daily strategy note:

```text
vision/daily/YYYY/MM/YYYY-MM-DD.md
```

Decisions note:

```text
vision/decisions/YYYY/MM/YYYY-MM-DD.md
```

Research note with `--research`:

```text
vision/research/YYYY/MM/YYYY-MM-DD.md
```

Master todos:

```text
vision/todos.md
```

`vision/todos.md` uses a generated marker block so your own notes outside the block are preserved:

```md
<!-- founder-sync:generated:start -->
...
<!-- founder-sync:generated:end -->
```

## Weekly Developer Summary

Generate a weekly developer-wise summary from existing daily org-sync reports without re-running git:

```bash
org-weekly-summary --org-root /Users/chandan/Desktop/projects/upandup_org
```

Options:

```text
  --org-root <path>   Folder containing org-sync-reports/. Required.
  --since-days <n>    Number of past days to include. Default: 7.
  --output-dir <path> Output directory. Default: <org-root>/org-sync-weekly/<timestamp>.
  --dry-run           Print planned actions without writing files.
  --help              Show this help.
```

### Weekly output artifacts

```text
org-sync-weekly/<timestamp>/
  weekly-summary.md             # Markdown: developer-wise, product/GTM/sales oriented
  weekly-summary.json           # JSON: structured weekly data
  developer-summary.md          # Markdown: detailed per-developer breakdown
  agency-briefs/
    index.json
    product.md
    gtm.md
    sales.md
    marketing.md
    engineering.md
    customer-success.md
```

Plus Markdown-only compatibility/archive copies in `vision/`:

```text
vision/weekly-analysis-YYYY-MM-DD.md                   # Markdown only
vision/weekly/YYYY/MM/weekly-YYYY-MM-DD.md             # Markdown only
```

No JSON is written under `vision/` — only Markdown.

### Multi-org weekly summary

Run weekly summary via `org-sync-all --weekly`:

```bash
# After sync, generate weekly summaries for all orgs
org-sync-all --weekly

# With custom weekly args
org-sync-all --weekly --weekly-args '--since-days 14'

# Dry run to preview
org-sync-all --weekly --dry-run
```

Or from npm:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm run org:sync:all -- --weekly
npm run org:weekly -- --org-root /Users/chandan/Desktop/projects/upandup_org
```

### Weekly summary is deterministic

`org-weekly-summary` reads existing `org-sync-reports/*/run-summary.json` and `founder-signals.json`. It does **not**:

- run git commands
- invoke LLM/agents
- write to org-sync-reports (which would create duplicate daily runs)

It filters reports by `--since-days` using `generatedAt` timestamps.

### Weekly summary content

The weekly summary is:

- **Developer-wise**: aggregates commits, repos, commit subjects, product flows, and risk tags per developer across all days
- **Product/GTM/Sales-oriented**: includes domain-specific agency briefs for each function
- **Linked to daily reports**: includes links back to the raw daily reports
- **Includes agency briefs**: deterministic prompts for Product, GTM, Sales, Marketing, Engineering, Customer Success

### Using weekly summaries in the dashboard

The dashboard automatically detects `org-sync-reports/<run>/agency-briefs/` and `org-sync-weekly/` directories and displays links on the org page.

## If `org-sync` command is not found

Run it through npm from the tool repo:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm run org:sync -- --org-root /Users/chandan/Desktop/projects/upandup_org
```

Or redo the one-time link:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm link
```

## Output files

Multi-org runs create a global dashboard index at the projects root:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
  index.json
  daily/YYYY-MM-DD.json
  orgs/<org-name>.json
```

The localhost dashboard reads this folder and links back to per-org reports, notes, and vision files.

Each run creates raw artifacts in `org-sync-reports/`:

```text
org-sync-reports/<timestamp>/
  report.md
  founder-signals.json
  deep-review-prompt.md       # when --deep is passed
  release-review-prompt.md    # when --release is passed
  org-prompt.md
  run-summary.json
  agency-briefs/              # deterministic agency-ready prompts
    index.json
    product.md
    gtm.md
    sales.md
    marketing.md
    engineering.md
    customer-success.md
  repos/<repo-name>/
    git-summary.md
    llm-prompt.md
    summary.json
```

Agency briefs are deterministic Markdown prompts with structured evidence from git changes. They include:
- org/date/window/report path
- changed repos and developer rollups
- product flows and risk tags
- domain-specific questions for each agency (Product, GTM, Sales, Marketing, Engineering, Customer Success)
- guardrails: "do not infer beyond evidence"

Agency briefs are deterministic Markdown prompts with structured evidence. In the default SOP, `org-sync` also invokes OpenCode for the main report; these briefs remain reusable inputs for Product, GTM, Sales, Marketing, Engineering, and Customer Success follow-up analysis.

`run-summary.json` and `founder-signals.json` now include a `developers` array aggregating developer-wise changes across repos: name, email, commits count, repos, commitSubjects, productFlows, riskTags. They also include `agencyBriefsPath` pointing to the generated agency briefs directory.

These raw artifacts may contain `.json` files and are not intended to be used directly as an Obsidian folder.

Each run also creates Markdown-only Obsidian notes in `org-sync-notes/`:

```text
org-sync-notes/
  _index.md
  YYYY/MM/YYYY-MM-DD.md
  repos/<repo-name>.md
```

Use `org-sync-notes/` as the Obsidian folder/vault. Every file created inside it is `.md`.

Daily notes include:

- executive summary
- repo-wise changes
- developer-wise details: who did what, based on commit authors/messages
- before/after behavior from OpenCode by default, or deterministic fallback when `--no-llm` is used / OpenCode fails
- risk and recommended checks
- links to repo notes

`founder-signals.json` is the structured bridge from engineering to founder strategy. It includes deterministic heuristic tags for:

- product-critical flows touched,
- risk tags,
- changed files,
- commits,
- whether deep/release review is recommended.

Heuristic tags are useful triage, not proof. Run source review and MCP/GitNexus impact analysis manually for high-risk changes.

Do not commit generated reports unless you reviewed them for sensitive code, diffs, paths, or secrets.

## SOP: Fresh Org Setup / Founder Baseline

Run these steps when setting up org intelligence for a new `*_org` folder or after clearing generated data.

### 1. Cleanup dry-run

Preview what will be removed without deleting:

```bash
cd /Users/chandan/Desktop/projects/org-sync-tools
npm run org:cleanup -- --include upandup_org --dry-run
```

This checks `org-sync-reports/` for duplicate runs. Today's runs are kept by default (pass `--no-keep-all-today` to override).

### 2. Remove stale run directories (post-review)

```bash
npm run org:cleanup -- --include upandup_org --no-dry-run
```

Repeat for other orgs:

```bash
npm run org:cleanup -- --include zynd_org --no-dry-run
```

### 3. Remove stale founder-sync-runs

```bash
rm -rf /Users/chandan/Desktop/projects/upandup_org/founder-sync-runs
```

### 4. Remove stale daily notes (keep only latest)

```bash
# Keep only the newest daily note in org-sync-notes/YYYY/MM/
# Then update org-sync-notes/_index.md to remove stale links
```

### 5. Generate weekly baseline

Generate a weekly developer-wise summary from existing daily reports (no re-run of git):

```bash
cd /Users/chandan/Desktop/projects/upandup_org
org-weekly-summary --since-days 7
```

For zynd_org:

```bash
cd /Users/chandan/Desktop/projects/zynd_org
org-weekly-summary --since-days 7
```

Or generate a deep baseline run if no daily reports exist yet:

```bash
cd /Users/chandan/Desktop/projects/upandup_org
org-sync --since "1 week ago" --no-pull --deep --release
```

### 6. Remove duplicate report directories

```bash
npm run org:cleanup -- --include upandup_org --no-dry-run
npm run org:cleanup -- --include zynd_org --no-dry-run
```

### 7. Create vision/product-overview.md

Write a one-page summary of the product/vision from known context — mission, vertical, hierarchy, UX surfaces, tracked primitives, trust/BGV, feature toggles, design principles, architecture.

Place at:

```text
vision/product-overview.md
```

### 8. Review weekly analysis

The weekly summary script (`org-weekly-summary`) automatically writes:

```text
vision/weekly-analysis-YYYY-MM-DD.md
vision/weekly/YYYY/MM/weekly-YYYY-MM-DD.md
```

Review the generated weekly summary for accuracy. Optionally enhance with founder interpretation:

- key changes per repo
- risks and validation gates
- GTM/sales implications
- tomorrow's daily-runs note

### 9. Refresh global dashboard index

Update `.org-intel-global/index.json` and `.org-intel-global/orgs/<org>.json` to point at the new weekly run (not at any deleted run). The dashboard reads these files to link reports.

```bash
# Run org-sync-all for the org to regenerate the global index:
cd /Users/chandan/Desktop/projects/org-sync-tools
npm run org:sync:all -- --include upandup_org
```

Or manually edit the JSON files to update `reportPath`, `founderSignalsPath`, `generatedAt`, and summary fields.

### 10. Start dashboard

```bash
org-dashboard
# Opens at http://localhost:3877
```

Verify: org page loads, runs show correct canonical run, artifact links resolve.

### Summary Checklist

- [ ] Cleanup dry-run confirms expected deletions
- [ ] Stale report dirs removed
- [ ] `founder-sync-runs/` removed
- [ ] Stale daily notes removed; `_index.md` updated
- [ ] Weekly baseline generated (--deep --release)
- [ ] Duplicate report dirs cleaned
- [ ] `vision/product-overview.md` created
- [ ] `vision/weekly-analysis-YYYY-MM-DD.md` created
- [ ] Global dashboard index refreshed
- [ ] Dashboard loads new run
