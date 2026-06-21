# Setup Guide

First-time setup from a fresh clone. Takes about 10 minutes.

## 1. Prerequisites

```bash
node --version    # needs 18+
git --version
opencode --help   # OpenCode CLI — install from https://opencode.ai
```

GitNexus is optional (structural impact analysis):

```bash
npx gitnexus --version
```

## 2. Clone

Clone into your projects folder — next to your `*_org` folders, not inside one:

```bash
cd ~/projects
git clone https://github.com/chandan867/org_sync.git org-sync-tools
cd org-sync-tools
npm install
npm link
```

Your folder should look like:

```text
~/projects/
  upandup_org/
    mobile-app/
    backend/
  zynd_org/
    api/
  org-sync-tools/    ← you are here
```

Verify the CLI commands are available:

```bash
org-sync --help
org-sync-all --help
org-dashboard --help
```

## 3. Dry run

Preview what will happen without writing anything:

```bash
cd ~/projects
org-sync-all --dry-run
```

You should see planned commands for each `*_org` folder found.

## 4. First sync (with LLM)

```bash
cd ~/projects
org-sync-all
```

This runs for each org:
1. Collects git changes, maps product flows and risk signals
2. Calls OpenCode to synthesize a founder report
3. Calls OpenCode 6 more times to generate agency briefs (Product, GTM, Sales, Marketing, Engineering, Customer Success)
4. Runs `founder-sync` to write vision notes

**Takes 5–15 minutes** depending on how many repos have changes. Each org makes 7 OpenCode calls.

## 5. Open the dashboard

```bash
org-dashboard &
open http://localhost:3877
```

- Home page: cross-org summary (repos changed, critical flows, high-risk)
- Click an org to see the briefing, agency briefs, and repo signals
- The dashboard is read-only — safe to leave running

## 6. Add per-org product rules (recommended)

The default rules cover generic patterns. Add rules specific to your product for better signal quality.

Create `<org>/vision/product-overview.md`:

````markdown
# My Product — Overview

Brief description of what the product does.

## Org-Sync Rules

```org-sync:product-flows
[
  { "id": "checkout", "label": "Checkout Flow", "severity": "critical",
    "pathPatterns": ["checkout", "cart", "payment", "order"],
    "textPatterns": ["checkout", "cart", "payment intent"] },
  { "id": "onboarding", "label": "User Onboarding", "severity": "high",
    "pathPatterns": ["onboard", "signup", "register", "invite"],
    "textPatterns": ["onboarding", "signup", "invite"] }
]
```

```org-sync:risk-rules
[
  { "id": "db-migration", "label": "DB Schema Migration", "severity": "high",
    "pathPatterns": ["migration", "prisma", "schema"],
    "textPatterns": ["migration", "schema change"] }
]
```

```org-sync:domain
{ "label": "E-commerce / B2C" }
```
````

Run the sync again after adding rules — it picks them up automatically, no restart needed.

## Daily from here on

Two commands, from `~/projects`:

```bash
org-sync-all
```
Syncs all orgs, generates LLM reports and all 6 agency briefs. Run this every morning.

```bash
org-dashboard &
open http://localhost:3877
```
Opens the dashboard. The dashboard always shows the latest LLM-completed run automatically.

---

## Optional: auto-run on macOS

Install a LaunchAgent that runs the sync once per day automatically:

```bash
npm run org:auto:install
launchctl list | grep org-sync   # verify it loaded
```

Force a run now:

```bash
npm run org:auto:run -- --force
```

Check logs:

```bash
cat ~/projects/.org-intel-global/launchd.err.log
```

Uninstall:

```bash
npm run org:auto:uninstall
```

## Optional: weekly summary

```bash
org-weekly-summary --org-root ~/projects/upandup_org
```

Or run it automatically after every daily sync:

```bash
org-sync-all --weekly
```

## Optional: clean up old runs

Keep one run per day, delete duplicates:

```bash
npm run org:cleanup -- --include upandup_org             # preview
npm run org:cleanup -- --include upandup_org --no-dry-run  # apply
```

---

## Troubleshooting

**Commands not found after `npm link`**
```bash
npm link
hash -r
```

**No orgs found**
- Folders must end in `_org`
- Run from the projects root, or set `ORG_SYNC_PROJECTS_ROOT=~/projects`

**No repos found in an org**
- Repos must be immediate children of the `*_org` folder (no nesting)
- Check: `org-sync --dry-run --org-root ~/projects/upandup_org`

**OpenCode fails**
- Run `opencode --help` to verify it's installed
- Use `--no-llm` to skip OpenCode: `org-sync-all --org-args '--no-llm'`

**Dashboard shows no data**
- Run a sync first: `org-sync-all`
- Restart the dashboard after syncing

**Dashboard shows old run**
- The dashboard picks the latest LLM-completed run automatically
- If you see a stale run, check that `run-summary.json` exists in the newest directory under `<org>/org-sync-reports/`
