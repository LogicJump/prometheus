/**
 * Persistent approval rules.
 *
 * "Always allow" used to live only in memory, so the same prompt came back on
 * the next launch. Rules are stored in ~/.prometheus/rules.json and match on:
 *
 *   tool     a tool name, or `*`
 *   match    an optional glob over the summarised call detail (path, command)
 *   scope    "user" (every workspace) or "project" (this workspace only)
 *   action   "allow" (skip the prompt) or "deny" (refuse without asking)
 *
 * Rules are evaluated in order; the first match wins, so a deny can sit above a
 * broad allow. They are user data: never loaded from anywhere but the file the
 * user owns, and the CLI can list or edit them (`/rules`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export type RuleAction = "allow" | "deny";
export type RuleScope = "user" | "project";

export interface ApprovalRule {
  id: string;
  tool: string;
  match?: string;
  action: RuleAction;
  scope: RuleScope;
  /** Absolute workspace for project rules; empty for user rules. */
  cwd?: string;
  note?: string;
  createdAt: string;
}

interface RuleFile {
  rules?: ApprovalRule[];
}

const FILE = join(CONFIG_HOME, "rules.json");

export function loadRules(): ApprovalRule[] {
  try {
    if (!existsSync(FILE)) return [];
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as RuleFile;
    return Array.isArray(parsed.rules) ? parsed.rules.filter((rule) => rule && typeof rule.tool === "string") : [];
  } catch {
    return [];
  }
}

function saveRules(rules: ApprovalRule[]): void {
  mkdirSync(CONFIG_HOME, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ rules }, null, 2), "utf8");
}

export function addRule(rule: Omit<ApprovalRule, "id" | "createdAt">): ApprovalRule {
  const created: ApprovalRule = {
    ...rule,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
  };
  const rules = loadRules();
  // Replace an identical rule instead of accumulating duplicates.
  const duplicate = rules.findIndex(
    (existing) =>
      existing.tool === created.tool &&
      (existing.match ?? "") === (created.match ?? "") &&
      existing.action === created.action &&
      existing.scope === created.scope &&
      (existing.cwd ?? "") === (created.cwd ?? ""),
  );
  if (duplicate >= 0) rules.splice(duplicate, 1);
  rules.push(created);
  saveRules(rules);
  return created;
}

export function removeRule(id: string): boolean {
  const rules = loadRules();
  const next = rules.filter((rule) => rule.id !== id);
  if (next.length === rules.length) return false;
  saveRules(next);
  return true;
}

/** Rules that apply to this workspace, in evaluation order. */
export function rulesFor(cwd: string): ApprovalRule[] {
  const normalized = cwd.replace(/\\/g, "/").toLowerCase();
  return loadRules().filter((rule) => {
    if (rule.scope === "user") return true;
    return (rule.cwd ?? "").replace(/\\/g, "/").toLowerCase() === normalized;
  });
}

/**
 * Parse a `Tool(specifier)` rule string into a tool name and a matcher.
 *
 * `Bash(git *)`, `read_file(src/**)` and `mcp__github__*` cover the three
 * cases that a tool-level rule cannot: one shape of a command, one part of the
 * tree, one MCP server. Anything without parentheses keeps the old meaning, so
 * existing rules parse exactly as before.
 */
export function parseRuleSpec(spec: string): { tool: string; match?: string } | null {
  const text = String(spec ?? "").trim();
  if (!text) return null;
  const open = text.indexOf("(");
  if (open < 0) return { tool: text };
  if (!text.endsWith(")")) return null;
  const tool = text.slice(0, open).trim();
  const match = text.slice(open + 1, -1).trim();
  if (!tool) return null;
  return match ? { tool, match } : { tool };
}

/** Glob over the call detail: `*` matches any run of characters. */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i").test(text);
  } catch {
    return pattern === text;
  }
}

/**
 * The first rule that applies to a call, if any. `detail` is the tool's
 * summary (path or command), which is what the user saw when creating it.
 */
export function matchRule(rules: ApprovalRule[], toolName: string, detail: string): ApprovalRule | null {
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    if (!globMatch(rule.match ?? "", detail)) continue;
    return rule;
  }
  return null;
}

/**
 * Match a rule against a structured call, falling back to the summary.
 *
 * A `Bash(git status*)` rule has to look at the command, not at the summary
 * the approval prompt showed — the summary appends the model's prose
 * description, so a correctly scoped rule would miss its own call. Tools pass
 * the argument their rule is written against (`command` for bash, `path` for
 * file tools, the tool name itself for a whole MCP server).
 */
export function matchRuleAgainst(
  rules: ApprovalRule[],
  toolName: string,
  summary: string,
  argument: string | undefined,
): ApprovalRule | null {
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    const candidate = argument ?? summary;
    if (!globMatch(rule.match ?? "", candidate)) {
      // A path rule written as `src/**` should also match `src/a/b.ts` when
      // the tool reports an absolute path in the summary.
      if (!argument || !globMatch(rule.match ?? "", summary)) continue;
    }
    return rule;
  }
  return null;
}

export type RememberChoice = "always-tool" | "always-detail";

/**
 * Turn an "always allow" answer into a rule. A file tool remembers the exact
 * path; a shell command remembers the command line, never a blanket "all
 * commands".
 */
export function ruleFromChoice(toolName: string, detail: string, scope: RuleScope, cwd: string, choice: string): ApprovalRule {
  // `detail` is what the rule is narrowed to. An empty one means the user
  // chose the whole tool, so the note carries the name alone instead of a
  // dangling `bash: ` that reads like a truncated summary.
  const rule: Omit<ApprovalRule, "id" | "createdAt"> = {
    tool: toolName,
    action: "allow",
    scope,
    ...(scope === "project" ? { cwd } : {}),
    note: detail ? `${toolName}: ${detail.slice(0, 80)}` : `${toolName}: every call`,
  };
  if (choice === "always-tool" || !detail) return addRule(rule);
  return addRule({ ...rule, match: detail.split("\n")[0].slice(0, 200) });
}
