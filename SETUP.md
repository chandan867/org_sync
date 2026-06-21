# Setup Guide

This guide sets up `org_sync` from a fresh clone.

## 1. Prerequisites

Install or verify:

```bash
node --version
npm --version
git --version
opencode --help
```

Requirements:

- Node.js 18+
- npm
- git
- OpenCode CLI
- macOS for automatic LaunchAgent setup

## 2. Clone

```bash
cd /Users/chandan/Desktop/projects
git clone https://github.com/chandan867/org_sync.git org-sync-tools
cd org-sync-tools
```

## 3. Install dependencies

```bash
npm install
```

## 4. Link CLI commands

```bash
npm link
```

Verify:

```bash
org-sync --help
org-sync-all --help
founder-sync --help
org-weekly-summary --help
org-dashboard --help
```

If you do not want to use `npm link`, run commands through npm:

```bash
npm run org:sync -- --help
npm run org:sync:all -- --help
npm run founder:sync -- --help
npm run dashboard -- --help
```

## 5. Prepare org folders

Org folders must live under the projects root and end with `_org`:

```text
/Users/chandan/Desktop/projects/upandup_org
/Users/chandan/Desktop/projects/zynd_org
```

Each org folder should contain one or more immediate child Git repos:

```text
upandup_org/
  mobile-app/.git
  backend/.git
  frontend/.git
```

## 6. First dry run

Preview all orgs:

```bash
org-sync-all --dry-run
```

Preview one org:

```bash
org-sync-all --include upandup_org --dry-run
```

Expected: commands for `org-sync` and `founder-sync` are printed, but no reports are written.

## 7. First daily sync

Run one org:

```bash
org-sync-all --include upandup_org
```

Run all orgs:

```bash
org-sync-all
```

Default behavior:

- no remote pull (`--no-pull`)
- OpenCode LLM enabled by default
- founder sync enabled by default
- reports written under each org

Use local-only mode if needed:

```bash
org-sync-all \
  --include upandup_org \
  --org-args '--since "1 day ago" --no-pull --no-llm' \
  --founder-args '--no-llm'
```

## 8. Weekly summary

Generate weekly summary for one org:

```bash
org-weekly-summary --org-root /Users/chandan/Desktop/projects/upandup_org
```

Or run weekly after the daily multi-org sync:

```bash
org-sync-all --weekly
```

Expected output:

```text
org-sync-weekly/<timestamp>/weekly-summary.md
org-sync-weekly/<timestamp>/developer-summary.md
org-sync-weekly/<timestamp>/agency-briefs/
```

## 9. Dashboard

Start:

```bash
org-dashboard
```

Open:

```text
http://localhost:3877
```

The dashboard is read-only. It does not run Git, syncs, OpenCode, LLMs, or agents.

## 10. Auto-run on macOS

Preview:

```bash
npm run org:auto:install -- --dry-run
```

Install:

```bash
npm run org:auto:install
```

Manual forced run:

```bash
npm run org:auto:run -- --force
```

Uninstall:

```bash
npm run org:auto:uninstall
```

Local-only auto-run install:

```bash
npm run org:auto:install -- \
  --org-args '--since "1 day ago" --no-pull --no-llm' \
  --founder-args '--no-llm'
```

## 11. Generated folders

Per org:

```text
org-sync-reports/
org-sync-weekly/
org-sync-notes/
founder-sync-runs/
vision/
```

Global:

```text
/Users/chandan/Desktop/projects/.org-intel-global/
```

These are generated/local intelligence artifacts. Review before committing or sharing.

## 12. Cleanup

Preview duplicate cleanup:

```bash
npm run org:cleanup -- --include upandup_org --dry-run
```

Apply cleanup:

```bash
npm run org:cleanup -- --include upandup_org --no-dry-run
```

## 13. Common issues

### OpenCode not configured

Check:

```bash
opencode --help
```

Use `--no-llm` to avoid OpenCode.

### Commands unavailable after `npm link`

Run:

```bash
npm link
hash -r
```

Or run through npm scripts.

### No orgs found

Make sure folders end in `_org` and are under:

```text
/Users/chandan/Desktop/projects
```

### Dashboard empty

Run:

```bash
org-sync-all --include upandup_org
```

Then restart:

```bash
org-dashboard
```
