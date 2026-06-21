# Setup Guide

First-time setup from a fresh clone. Takes about 5 minutes.

## 1. Prerequisites

```bash
node --version   # needs 18+
npm --version
git --version
opencode --help  # OpenCode CLI — for LLM synthesis
```

GitNexus is optional but recommended for blast-radius analysis:

```bash
npx gitnexus --version
```

macOS is required only for the LaunchAgent auto-run feature. Everything else works on Linux too.

## 2. Clone into your projects folder

Clone next to your `*_org` folders — not inside one:

```bash
cd ~/projects   # or wherever your *_org folders live
git clone https://github.com/chandan867/org_sync.git org-sync-tools
cd org-sync-tools
npm install
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

## 3. Link CLI commands (optional but recommended)

```bash
npm link
```

Verify:

```bash
org-sync --help
org-sync-all --help
founder-sync --help
org-dashboard --help
```

If you skip `npm link`, use `npm run` equivalents instead:

```bash
npm run org:sync -- --help
npm run org:sync:all -- --help
npm run founder:sync -- --help
npm run dashboard -- --help
```

## 4. Set your projects root (optional)

By default, every script uses `process.cwd()` as the projects root. If you always run from a different folder, set it permanently:

```bash
# add to ~/.zshrc or ~/.bashrc
export ORG_SYNC_PROJECTS_ROOT="$HOME/projects"
```

You can also pass it per-command: `org-sync-all --projects-root ~/projects`

## 5. Prepare your org folders

Each `*_org` folder needs immediate child Git repos (not nested deeper):

```text
upandup_org/
  mobile-app/.git     ✓
  backend/.git        ✓
  nested/deep/repo/   ✗ (not discovered)
```

No other setup is needed. The `vision/` folder and all report directories are created automatically on first sync.

## 6. Customize product rules (recommended)

The default product-flow rules cover generic patterns (auth, payments, core user flow, notifications, integrations, admin). For better signal quality, add rules specific to your product.

Create or edit `<org>/vision/product-overview.md` and add fenced blocks:

````markdown
# My Product — Overview

Brief description of what the product does.

## Org-Sync Rules

```org-sync:product-flows
[
  { "id": "core-checkout", "label": "Checkout Flow", "severity": "critical",
    "pathPatterns": ["checkout", "cart", "payment", "order"],
    "textPatterns": ["checkout", "cart", "payment intent"] },
  { "id": "onboarding", "label": "User Onboarding", "severity": "critical",
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

Rules use case-insensitive regex patterns. If the blocks are absent, generic defaults are used — the tool works fine without custom rules.

## 7. First dry run

Preview what will happen without writing anything:

```bash
cd ~/projects
org-sync-all --dry-run
```

Or for one org:

```bash
org-sync-all --include upandup_org --dry-run
```

Expected output: planned commands for each org, no files written.

## 8. First real sync

Run one org without OpenCode first (fast, no API calls):

```bash
org-sync-all --include upandup_org --org-args '--no-pull --no-llm'
```

This writes a structured report, agency briefs, and founder signals without calling OpenCode. Check the output:

```bash
ls upandup_org/org-sync-reports/
```

Then open the dashboard to see it:

```bash
org-dashboard &
open http://localhost:3877
```

## 9. Full sync with OpenCode

Once you've confirmed the structure looks right:

```bash
org-sync-all --include upandup_org
```

Default behavior:
- No remote pull (`--no-pull` is the default in `org-sync-all`)
- OpenCode enabled — synthesises a founder-facing report
- `founder-sync` runs after each org to write vision notes

To pull before syncing:

```bash
org-sync-all --include upandup_org --org-args '--since "1 day ago"'
```

## 10. Open the dashboard

```bash
org-dashboard
```

Navigate to:
- `http://localhost:3877` — home page with cross-org metrics
- `http://localhost:3877/orgs/upandup_org` — org-level digest, agency briefs, signals

The dashboard is read-only — it only reads generated artifacts, never runs git or LLM calls.

## 11. Set up auto-run on macOS

Install a once-per-day LaunchAgent that runs the sync automatically:

```bash
# preview what will be installed
npm run org:auto:install -- --dry-run

# install
npm run org:auto:install

# verify it loaded
launchctl list | grep org-sync
```

Force a run now to verify:

```bash
npm run org:auto:run -- --force
```

Check logs if something is wrong:

```bash
cat "$HOME/projects/.org-intel-global/launchd.err.log"
cat "$HOME/projects/.org-intel-global/logs/$(date +%Y-%m-%d).log"
```

Uninstall:

```bash
npm run org:auto:uninstall
```

## 12. Weekly summary

Generate a 7-day rollup for one org from existing daily reports:

```bash
org-weekly-summary --org-root ~/projects/upandup_org
```

Or run weekly after every daily sync automatically:

```bash
org-sync-all --weekly
```

## 13. Cleanup old runs

The cleanup script keeps one canonical run per day and removes duplicates:

```bash
# preview (dry run is the default)
npm run org:cleanup -- --include upandup_org

# apply
npm run org:cleanup -- --include upandup_org --no-dry-run
```

## Common issues

### Commands not found after `npm link`

```bash
npm link
hash -r   # reload shell PATH cache
```

Or use `npm run org:sync -- --help` instead of the linked binary.

### No orgs found

- Make sure folders end in `_org`
- Run from the projects root, or set `ORG_SYNC_PROJECTS_ROOT`
- Check with: `ls ~/projects | grep _org`

### No repos found in an org

- Repos must be immediate children of the `*_org` folder with a `.git` directory
- Run `org-sync --dry-run --org-root ~/projects/upandup_org` to see what's discovered

### Dashboard shows no data

Run a sync first, then restart the dashboard:

```bash
org-sync-all --include upandup_org --org-args '--no-llm'
org-dashboard
```

### OpenCode fails

```bash
opencode --help   # verify it's installed
```

Use `--no-llm` to skip OpenCode and get the deterministic structured report instead.

### Auto-run LaunchAgent not firing

Check:
1. `launchctl list | grep org-sync` — should show the label
2. `cat ~/projects/.org-intel-global/launchd.err.log`
3. Verify the projects root path in the plist: `cat ~/Library/LaunchAgents/dev.upandup.org-sync-auto.plist`

Re-install if needed: `npm run org:auto:uninstall && npm run org:auto:install`
