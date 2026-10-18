/**
 * Instructions and rules, loaded into the system prompt.
 *
 * Two kinds of guidance, with different lifetimes:
 *
 *   instructions   Standing prose. `~/.prometheus/instructions.md`, then every
 *                  PROMETHEUS.md / AGENTS.md / CLAUDE.md from the workspace root
 *                  down to cwd, nearest last so it can override.
 *   rules          Topic files under `rules/` with optional `paths:` globs.
 *                  A rule with no globs always applies; a scoped rule is only
 *                  injected once the agent touches a matching file, which keeps
 *                  a monorepo's frontend conventions out of a backend turn.
 *
 * Both support `@path/to/file` imports (four hops), the same syntax the
 * instruction files already use for prose, so a rule can share a checklist
 * instead of copying it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename, relative, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { globToRegExp } from "./tools/fsUtil.ts";

const FILE_NAMES = ["PROMETHEUS.md", "AGENTS.md", "CLAUDE.md"];
const CONFIG_HOME = join(homedir(), ".prometheus");
const MAX_IMPORT_DEPTH = 4;

export interface Rule {
  name: string;
  /** Empty means "always apply". */
  paths: string[];
  body: string;
  source: string;
}

/** Parse optional YAML-ish frontmatter; only `paths` is understood here. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (field) meta[field[1]] = field[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Expand `@relative/path` imports, bounded so a cycle cannot hang the prompt. */
export function expandImports(text: string, baseDir: string, depth = 0): string {
  if (depth >= MAX_IMPORT_DEPTH) return text;
  return text.replace(/(^|\s)@([\w./\\-]+\.(?:md|txt))/g, (whole, lead: string, target: string) => {
    const file = isAbsolute(target) ? target : resolve(baseDir, target);
    try {
      if (!existsSync(file) || !statSync(file).isFile()) return whole;
      const body = expandImports(readFileSync(file, "utf8").trim(), dirname(file), depth + 1);
      return `${lead}${body}`;
    } catch {
      return whole;
    }
  });
}

/** Read every .md in a rules directory. Unreadable files are skipped, never fatal. */
function readRulesDir(dir: string, origin: string): Rule[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Rule[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(dir, entry), "utf8");
      const { meta, body } = parseFrontmatter(text);
      const paths = (meta.paths ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      out.push({
        name: entry.slice(0, -3),
        paths,
        body: expandImports(body.trim(), dir),
        source: `${origin}/${entry}`,
      });
    } catch {
      /* skip unreadable rules */
    }
  }
  return out;
}

/** Global rules first, then project rules; a project rule with the same name wins. */
export function loadRules(cwd = process.cwd()): Rule[] {
  const merged = new Map<string, Rule>();
  for (const rule of readRulesDir(join(CONFIG_HOME, "rules"), "global")) merged.set(rule.name, rule);
  for (const rule of readRulesDir(join(cwd, ".prometheus", "rules"), "project")) merged.set(rule.name, rule);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when a rule's `paths` globs match a workspace-relative file path. */
export function ruleMatches(rule: Rule, filePath: string, cwd = process.cwd()): boolean {
  if (rule.paths.length === 0) return true;
  const rel = relative(resolve(cwd), resolve(cwd, filePath)).split("\\").join("/");
  return rule.paths.some((pattern) => {
    try {
      return globToRegExp(pattern).test(rel);
    } catch {
      return false;
    }
  });
}

/** Rules that apply unconditionally, for the system prompt. */
export function alwaysRules(cwd = process.cwd()): Rule[] {
  return loadRules(cwd).filter((rule) => rule.paths.length === 0);
}

/**
 * Render the rules for a turn. `touched` is every file the conversation has
 * read or written; scoped rules join the prompt as soon as one matches.
 */
export function renderRules(rules: Rule[], touched: string[], cwd = process.cwd()): string {
  const active = rules.filter((rule) => ruleMatches(rule, "", cwd) || touched.some((path) => ruleMatches(rule, path, cwd)));
  if (active.length === 0) return "";
  return active.map((rule) => `## Rule: ${rule.name}\n\n${rule.body}`).join("\n\n");
}

/**
 * The instruction files, from the workspace root down to cwd. Loading every
 * ancestor instead of only the nearest one is what lets a monorepo keep a root
 * AGENTS.md and a package-level one that narrows it.
 */
export function loadProjectInstructions(cwd = process.cwd()): string {
  const parts: string[] = [];
  const globalFile = join(CONFIG_HOME, "instructions.md");
  if (existsSync(globalFile)) {
    parts.push(expandImports(readFileSync(globalFile, "utf8").trim(), CONFIG_HOME));
  }

  // Collect ancestors from the root down, so the nearest file is applied last.
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 6; depth++) {
    chain.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const level of chain) {
    for (const name of FILE_NAMES) {
      const candidate = join(level, name);
      if (!existsSync(candidate)) continue;
      const label = level === resolve(cwd) ? name : join(basename(level), name);
      parts.push(`## ${label}\n\n${expandImports(readFileSync(candidate, "utf8").trim(), level)}`);
      break;
    }
  }
  return parts.filter(Boolean).join("\n\n");
}
