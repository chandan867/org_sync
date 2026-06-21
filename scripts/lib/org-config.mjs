// Shared configuration resolution for org_sync tools.
//
// Goals:
//  - Provide ONE home for the projects root default so it stops being
//    hardcoded across 7 scripts (each with its own env var name).
//  - Move PRODUCT_FLOW_RULES / RISK_RULES out of org-sync.mjs so they can be
//    overridden per-org via fenced blocks in vision/product-overview.md.
//
// This module is intentionally side-effect free and dependency-free: pure
// functions over filesystem strings. Other scripts import from here.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DEFAULT_PROJECTS_ROOT = process.env.ORG_SYNC_PROJECTS_ROOT
  || process.env.ORG_SYNC_AUTO_PROJECTS_ROOT
  || process.cwd();
export const DEFAULT_AGENTS_ROOT = path.join(DEFAULT_PROJECTS_ROOT, "agency-agents");

/**
 * Default product-flow rules — generic across any software product.
 * Per-org rules can be defined in vision/product-overview.md via fenced blocks.
 * These defaults cover the most common critical paths: auth, payments, core UX,
 * notifications, data/reporting, integrations, and admin/settings.
 */
export const DEFAULT_PRODUCT_FLOW_RULES = [
  {
    id: "auth-onboarding",
    label: "Auth / onboarding",
    severity: "critical",
    pathPatterns: [/auth/i, /login/i, /signup/i, /onboard/i, /register/i, /password/i, /forgot/i, /otp/i, /verify/i, /invite/i],
    textPatterns: [/login/i, /sign.?up/i, /onboard/i, /register/i, /forgot password/i, /otp/i, /invite/i],
  },
  {
    id: "payments-billing",
    label: "Payments / billing",
    severity: "critical",
    pathPatterns: [/payment/i, /billing/i, /subscription/i, /invoice/i, /checkout/i, /stripe/i, /razorpay/i, /price/i, /plan/i, /charge/i],
    textPatterns: [/payment/i, /billing/i, /subscription/i, /invoice/i, /checkout/i, /stripe/i, /razorpay/i],
  },
  {
    id: "core-user-flow",
    label: "Core user flow",
    severity: "critical",
    pathPatterns: [/dashboard/i, /home/i, /main/i, /feed/i, /profile/i, /account/i, /overview/i],
    textPatterns: [/dashboard/i, /user flow/i, /main screen/i, /home screen/i],
  },
  {
    id: "notifications-comms",
    label: "Notifications / communications",
    severity: "high",
    pathPatterns: [/notification/i, /email/i, /sms/i, /push/i, /alert/i, /message/i, /whatsapp/i, /chat/i],
    textPatterns: [/notification/i, /email/i, /sms/i, /push/i, /whatsapp/i],
  },
  {
    id: "data-reporting",
    label: "Data / export / reporting",
    severity: "high",
    pathPatterns: [/export/i, /report/i, /analytics/i, /download/i, /csv/i, /pdf/i, /insight/i, /metric/i],
    textPatterns: [/export/i, /report/i, /analytics/i, /insight/i],
  },
  {
    id: "integrations-api",
    label: "Integrations / API",
    severity: "high",
    pathPatterns: [/integrat/i, /webhook/i, /api/i, /third.?party/i, /external/i, /connect/i, /sync/i],
    textPatterns: [/integrat/i, /webhook/i, /third.?party/i],
  },
  {
    id: "admin-settings",
    label: "Admin / settings / permissions",
    severity: "medium",
    pathPatterns: [/admin/i, /setting/i, /config/i, /preference/i, /permission/i, /role/i, /access/i],
    textPatterns: [/admin/i, /setting/i, /config/i, /permission/i, /role/i],
  },
];

export const DEFAULT_RISK_RULES = [
  {
    id: "schema-or-persistence",
    label: "Schema or persistence touched",
    severity: "high",
    pathPatterns: [/migration/i, /database/i, /dao/i, /room/i, /entity/i, /schema/i, /model/i, /seed/i, /prisma/i, /knex/i],
  },
  {
    id: "network-contract",
    label: "Network/API contract touched",
    severity: "high",
    pathPatterns: [/api/i, /dto/i, /retrofit/i, /ktor/i, /remote/i, /route/i, /endpoint/i, /controller/i, /resolver/i],
    textPatterns: [/endpoint/i, /request/i, /response/i, /contract/i, /api/i],
  },
  {
    id: "security-sensitive",
    label: "Security-sensitive code touched",
    severity: "high",
    pathPatterns: [/auth/i, /token/i, /session/i, /permission/i, /otp/i, /cors/i, /secret/i, /key/i, /crypt/i, /jwt/i, /oauth/i],
    textPatterns: [/token/i, /session/i, /permission/i, /otp/i, /secret/i, /jwt/i],
  },
  {
    id: "critical-ui-flow",
    label: "Critical UI / UX flow touched",
    severity: "medium",
    pathPatterns: [/screen/i, /viewmodel/i, /fragment/i, /activity/i, /component/i, /page/i, /view/i, /layout/i],
  },
  {
    id: "infrastructure",
    label: "Infrastructure / DevOps touched",
    severity: "high",
    pathPatterns: [/dockerfile/i, /docker/i, /k8s/i, /kubernetes/i, /deploy/i, /infra/i, /terraform/i, /\.github/i, /\.env/i, /nginx/i, /caddy/i],
    textPatterns: [/deploy/i, /infrastructure/i, /docker/i, /kubernetes/i],
  },
  {
    id: "dirty-worktree",
    label: "Local uncommitted work present",
    severity: "medium",
    derived: (repoSummary) => repoSummary.after?.dirty || repoSummary.before?.dirty,
  },
];

// Editor/agent-generated files that leak into ls-files --others --exclude-standard
// and pollute the "untracked" / "dirty" / "reposWithChanges" signals. These are
// never meaningful product changes.
const UNTRACKED_NOISE_PATTERNS = [
  /^\.claude\//,
  /^\.gitnexus\//,
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /^\.cursor\//,
  /^\.idea\//,
  /^\.vscode\//,
];

/**
 * Resolve the projects root with a single precedence order, shared by every
 * caller that adopts this module:
 *   1. explicit --projects-root CLI value
 *   2. ORG_SYNC_PROJECTS_ROOT env
 *   3. ORG_SYNC_AUTO_PROJECTS_ROOT env (back-compat with the auto-runner)
 *   4. walk-up .org-sync.config.json { "projectsRoot": "..." }
 *   5. DEFAULT_PROJECTS_ROOT
 *
 * The auto-runner's env var is read for back-compat only; the canonical name
 * is ORG_SYNC_PROJECTS_ROOT. Callers that need absolute paths should pass an
 * already-resolved cliValue.
 */
export function resolveProjectsRoot(cliValue) {
  if (cliValue) return path.resolve(cliValue);
  if (process.env.ORG_SYNC_PROJECTS_ROOT) return path.resolve(process.env.ORG_SYNC_PROJECTS_ROOT);
  if (process.env.ORG_SYNC_AUTO_PROJECTS_ROOT) return path.resolve(process.env.ORG_SYNC_AUTO_PROJECTS_ROOT);
  return process.cwd();
}

/**
 * Resolve the agency-agents root. Honors an explicit value, then an env var,
 * then the default (which is derived from the projects root).
 */
export function resolveAgentsRoot(cliValue, projectsRoot) {
  if (cliValue) return path.resolve(cliValue);
  if (process.env.ORG_SYNC_AGENTS_ROOT) return path.resolve(process.env.ORG_SYNC_AGENTS_ROOT);
  return path.join(projectsRoot || DEFAULT_PROJECTS_ROOT, "agency-agents");
}

/**
 * Drop editor/agent-generated noise from a raw `git ls-files --others` listing.
 * Returns the cleaned string. Used at the single source point in
 * collectUncommittedSummary so the cleaned list flows into every consumer
 * (hasMeaningfulChanges, repoChangedFiles, matchRules, reports, prompts).
 */
export function filterUntrackedNoise(rawLines) {
  const text = String(rawLines ?? "");
  if (!text.trim()) return "";
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !UNTRACKED_NOISE_PATTERNS.some((re) => re.test(line)))
    .join("\n");
}

/**
 * Compile a rule's string pathPatterns/textPatterns into RegExp. Rules defined
 * in product-overview.md arrive as strings (JSON can't carry RegExp). We
 * compile leniently: invalid patterns are dropped (never throw).
 */
function compileRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const compiled = { ...rule };
  if (Array.isArray(rule.pathPatterns)) {
    compiled.pathPatterns = rule.pathPatterns
      .map((p) => compilePattern(p))
      .filter(Boolean);
  }
  if (Array.isArray(rule.textPatterns)) {
    compiled.textPatterns = rule.textPatterns
      .map((p) => compilePattern(p))
      .filter(Boolean);
  }
  if (typeof rule.derived === "function") compiled.derived = rule.derived;
  return compiled;
}

function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string" || !pattern.trim()) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Extract the contents of a fenced code block by its info string label.
 * Supports both ``` and ~~~ fences. Returns null if not found.
 *
 *   ```org-sync:product-flows
 *   [ ... ]
 *   ```
 */
function extractFencedBlock(markdown, label) {
  if (!markdown) return null;
  const openRe = new RegExp(`(^|\\n)(\`\`\`|~~~)\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`, "m");
  const openMatch = markdown.match(openRe);
  if (!openMatch) return null;
  const fence = openMatch[2];
  const startIdx = openMatch.index + openMatch[0].length;
  const tail = markdown.slice(startIdx);
  const closeRe = new RegExp(`(^|\\n)${fence}\\s*(\\n|$)`);
  const closeMatch = tail.match(closeRe);
  if (!closeMatch) return null; // unterminated fence — refuse to guess
  return tail.slice(0, closeMatch.index + (closeMatch[1] ? closeMatch[1].length : 0)).trim();
}

/**
 * Parse a rules JSON block defensively. Never throws: on any error returns []
 * and the caller falls back to defaults.
 */
function parseRulesBlock(blockText) {
  if (!blockText) return null;
  try {
    const parsed = JSON.parse(blockText);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(compileRule).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Load per-org rules from <orgRoot>/vision/product-overview.md fenced blocks.
 *
 * Recognized blocks:
 *   ```org-sync:product-flows   [ { id, label, severity, pathPatterns, textPatterns } ]
 *   ```org-sync:risk-rules      [ { id, label, severity, pathPatterns, textPatterns, derived? } ]
 *   ```org-sync:domain          { "label": "Workforce / PSA", "summary": "..." }
 *
 * If a block is absent or unparseable, the corresponding default rule set is
 * used (zero behavior change for orgs without a block).
 *
 * Returns { productFlows, riskRules, domainLabel, productOverviewPath, source }
 * where `source` records which blocks were found, for logging/debug.
 */
export async function loadOrgRules(orgRoot) {
  const productOverviewPath = path.join(orgRoot, "vision", "product-overview.md");
  const result = {
    productFlows: DEFAULT_PRODUCT_FLOW_RULES,
    riskRules: DEFAULT_RISK_RULES,
    domainLabel: null,
    productOverviewPath,
    source: { found: false, productFlows: false, riskRules: false, domain: false, reason: null },
  };
  if (!existsSync(productOverviewPath)) {
    result.source.reason = "no vision/product-overview.md found; using default rules";
    return result;
  }
  let markdown;
  try {
    markdown = await readFile(productOverviewPath, "utf8");
  } catch (err) {
    result.source.reason = `could not read product-overview.md: ${err.message}`;
    return result;
  }

  const flowsBlock = extractFencedBlock(markdown, "org-sync:product-flows");
  const risksBlock = extractFencedBlock(markdown, "org-sync:risk-rules");
  const domainBlock = extractFencedBlock(markdown, "org-sync:domain");

  if (flowsBlock) {
    const parsed = parseRulesBlock(flowsBlock);
    if (parsed && parsed.length > 0) {
      result.productFlows = parsed;
      result.source.productFlows = true;
    } else {
      result.source.reason = "product-flows block found but unparseable/empty; using defaults";
    }
  }
  if (risksBlock) {
    const parsed = parseRulesBlock(risksBlock);
    if (parsed && parsed.length > 0) {
      result.riskRules = parsed;
      result.source.riskRules = true;
    } else if (!result.source.reason) {
      result.source.reason = "risk-rules block found but unparseable/empty; using defaults";
    }
  }
  if (domainBlock) {
    try {
      const domain = JSON.parse(domainBlock);
      if (domain && typeof domain.label === "string") {
        result.domainLabel = domain.label;
        result.source.domain = true;
      }
    } catch {
      // ignore — domain label is cosmetic
    }
  }
  result.source.found = result.source.productFlows || result.source.riskRules || result.source.domain;
  return result;
}

/**
 * Quick existence check used by callers that want to validate a path before use.
 */
export async function isDirectory(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}
