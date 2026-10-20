/**
 * One approval input instead of two.
 *
 * `autoApprove` (a comma list in Settings, and `--allowed-tools` on the CLI)
 * and the saved rule list both answered "may this run without asking". They
 * were read in two places in the permission layer, shown in two places in the
 * UI, and a user could allow a tool in one and deny it in the other.
 *
 * The rule list wins because it has scope, a visible row, and a Remove button.
 * This turns an old `autoApprove` entry into the equivalent rule so behaviour
 * is unchanged after the migration, and clears the old field so it cannot come
 * back. `--allowed-tools` on the CLI still feeds `autoApprove` in memory; that
 * path is a per-run grant and does not write settings.
 */

import type { ApprovalRule } from "./rules.ts";

export interface AutoApproveMigrationInput {
  /** The stored list from settings, as it was before the UI removed the box. */
  autoApprove?: string[];
  /** Rules already saved; used to avoid duplicate rows. */
  existing?: Pick<ApprovalRule, "tool" | "match" | "action">[];
  /** Where to attach the rules: the user's rule file or this workspace's. */
  scope: "user" | "project";
  cwd?: string;
}

/**
 * The rules an old `autoApprove` list becomes.
 *
 * `Bash(git status)` keeps its matcher; a bare tool name becomes a whole-tool
 * rule with no `match`. A `*` entry is deliberately dropped: it meant "every
 * tool", which is what `bypassPermissions` is for and not something to write
 * into a rule file on a user's behalf.
 */
export function rulesFromAutoApprove(input: AutoApproveMigrationInput): Omit<ApprovalRule, "id" | "createdAt">[] {
  const entries = Array.isArray(input.autoApprove) ? input.autoApprove : [];
  const existing = input.existing ?? [];
  const out: Omit<ApprovalRule, "id" | "createdAt">[] = [];
  for (const raw of entries) {
    const spec = String(raw ?? "").trim();
    if (!spec || spec === "*") continue;
    const parsed = parseSpec(spec);
    if (!parsed.tool) continue;
    const duplicate = [...existing, ...out].some(
      (rule) => rule.tool === parsed.tool && (rule.match ?? "") === (parsed.match ?? "") && rule.action === "allow",
    );
    if (duplicate) continue;
    out.push({
      tool: parsed.tool,
      ...(parsed.match ? { match: parsed.match } : {}),
      action: "allow",
      scope: input.scope,
      ...(input.scope === "project" && input.cwd ? { cwd: input.cwd } : {}),
      note: "migrated from the old auto-approved tools list",
    });
  }
  return out;
}

/** `Bash(git status)` → `{tool: "Bash", match: "git status"}`; `read_file` → `{tool: "read_file"}`. */
function parseSpec(spec: string): { tool: string; match?: string } {
  const open = spec.indexOf("(");
  if (open < 0) return { tool: spec };
  if (!spec.endsWith(")")) return { tool: spec };
  const tool = spec.slice(0, open).trim();
  const match = spec.slice(open + 1, -1).trim();
  return match ? { tool, match } : { tool };
}
