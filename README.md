# org_sync

Project-level sync, founder intelligence, weekly reporting, cleanup, auto-run, and local dashboard tooling for folders that end in `_org`.

The tools are meant for a workspace shaped like this:

```text
/Users/chandan/Desktop/projects/
  upandup_org/
    repo-a/
    repo-b/
    vision/
  zynd_org/
    repo-c/
  org-sync-tools/
```

Each `*_org` folder can contain many Git repositories. `org_sync` scans those repos and creates daily/weekly intelligence artifacts for engineering, founder, product, GTM, sales, marketing, engineering review, and customer success.

## What it does

- Daily org reports from Git changes across all repos in an org.
- Founder strategy outputs from product/engineering movement.
- Weekly developer-wise summaries.
- Product/GTM/Sales/Marketing/Engineering/Customer Success agency briefs.
- Local read-only dashboard.
- Once-per-day macOS auto-run support.
- Cleanup for duplicate generated runs.

## Requirements

- Node.js 18+
- npm
- git
- OpenCode CLI configured on your machine
- macOS only for LaunchAgent auto-run install

OpenCode/LLM intelligence is part of the default SOP. Commands that support LLM use invoke OpenCode by default. Use `--no-llm` when you need local-only deterministic output.

## Install

```bash
git clone https://github.com/chandan867/org_sync.git
cd org_sync
npm install
npm link
```

Verify:

```bash
org-sync --help
org-sync-all --help
founder-sync --help
org-dashboard --help
```

## Daily sync

Run across all `*_org` folders under `/Users/chandan/Desktop/projects`:

```bash
org-sync-all
```

Default per org:

```bash
org-sync --since "1 day ago" --no-pull
founder-sync
```

Preview without writing:

```bash
org-sync-all --dry-run
```

Run for one org:

```bash
org-sync-all --include upandup_org
```

Local-only fallback:

```bash
org-sync-all \
  --org-args '--since "1 day ago" --no-pull --no-llm' \
  --founder-args '--no-llm'
```

## Weekly sync

Generate weekly developer/product/GTM summaries from existing daily reports:

```bash
org-weekly-summary --org-root /Users/chandan/Desktop/projects/upandup_org
```

Run weekly after daily multi-org sync:

```bash
org-sync-all --weekly
```

Custom window:

```bash
org-sync-all --weekly --weekly-args '--since-days 14'
```

## Founder sync

Founder sync reads latest org-sync output plus `vision/` context and writes founder-facing notes.

```bash
founder-sync --org-root /Users/chandan/Desktop/projects/upandup_org
```

With research output:

```bash
founder-sync --org-root /Users/chandan/Desktop/projects/upandup_org --research
```

Local-only fallback:

```bash
founder-sync --org-root /Users/chandan/Desktop/projects/upandup_org --no-llm
```

## Dashboard

Start the read-only local dashboard:

```bash
org-dashboard
```

Open:

```text
http://localhost:3877
```

The dashboard only reads generated artifacts. It does not run sync, Git, OpenCode, or LLM calls.

## Auto-run on macOS

Install once-per-day LaunchAgent:

```bash
npm run org:auto:install
```

Preview install:

```bash
npm run org:auto:install -- --dry-run
```

Run manually once:

```bash
npm run org:auto:run -- --force
```

Uninstall:

```bash
npm run org:auto:uninstall
```

## Generated artifacts

Per org daily reports:

```text
org-sync-reports/<timestamp>/
  report.md
  run-summary.json
  founder-signals.json
  agency-briefs/
  repos/<repo>/
```

Founder outputs:

```text
vision/
  daily/YYYY/MM/YYYY-MM-DD.md
  decisions/YYYY/MM/YYYY-MM-DD.md
  research/YYYY/MM/YYYY-MM-DD.md
  todos.md
  gtm-experiments.md
```

Weekly outputs:

```text
org-sync-weekly/<timestamp>/
  weekly-summary.md
  weekly-summary.json
  developer-summary.md
  agency-briefs/
```

Global dashboard index:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
```

Generated artifacts may contain code excerpts, diffs, paths, product strategy, and founder notes. Review before sharing or committing generated output.

## Project layout

```text
scripts/org-sync.mjs                 # one-org daily engineering sync
scripts/founder-sync.mjs             # founder/product strategy layer
scripts/org-sync-all.mjs             # multi-org runner
scripts/org-weekly-summary.mjs       # weekly developer/product summary
scripts/org-dashboard.mjs            # read-only localhost dashboard
scripts/org-sync-cleanup.mjs         # duplicate run cleanup
scripts/org-sync-auto-runner.mjs     # once-per-day runner
scripts/org-sync-auto-install.mjs    # macOS LaunchAgent install
scripts/org-sync-auto-uninstall.mjs  # macOS LaunchAgent uninstall
ORG_SYNC_GUIDE.md                    # detailed operating guide
SETUP.md                             # step-by-step setup
```

## Troubleshooting

### `org-sync` command not found

Run from the repo:

```bash
npm run org:sync -- --help
```

Or link again:

```bash
npm link
```

### OpenCode fails

Check OpenCode is installed and configured:

```bash
opencode --help
```

Use `--no-llm` for deterministic local-only output.

### No repos found

Make sure your org folder contains immediate child Git repos with `.git` directories.

### Dashboard has no data

Run a sync first:

```bash
org-sync-all --include upandup_org
```

### Auto-run does not work

Auto-run install is macOS-only. Check LaunchAgent logs in:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
```

## More docs

See [`SETUP.md`](./SETUP.md) for first-time setup and [`ORG_SYNC_GUIDE.md`](./ORG_SYNC_GUIDE.md) for the full operating guide.
