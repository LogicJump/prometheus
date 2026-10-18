/**
 * Editable files behind the Settings pages: MCP servers, skills (slash
 * commands), memory, and global instructions.
 *
 * The desktop app reads and writes these through the host so the renderer
 * never touches the filesystem. Every write is narrow: one file per entry,
 * and the on-disk formats stay exactly what the runtime already parses.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

/* ---------- MCP ---------- */

export interface McpServerEntry {
  name: string;
  scope: "user" | "project";
  command?: string;
  args?: string[];
  url?: string;
  disabled?: boolean;
}

function mcpFile(scope: "user" | "project", cwd: string): string {
  return scope === "project" ? join(cwd, ".prometheus", "mcp.json") : join(CONFIG_HOME, "mcp.json");
}

function readJsonFile(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function listMcpServers(cwd: string): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  for (const scope of ["user", "project"] as const) {
    const parsed = readJsonFile(mcpFile(scope, cwd)) as { servers?: Record<string, Record<string, unknown>> };
    for (const [name, server] of Object.entries(parsed.servers ?? {})) {
      if (!server || typeof server !== "object") continue;
      out.push({
        name,
        scope,
        command: typeof server.command === "string" ? server.command : undefined,
        args: Array.isArray(server.args) ? server.args.map(String) : undefined,
        url: typeof server.url === "string" ? server.url : undefined,
        disabled: Boolean(server.disabled),
      });
    }
  }
  return out;
}

export function saveMcpServer(cwd: string, entry: McpServerEntry): void {
  const file = mcpFile(entry.scope, cwd);
  const parsed = readJsonFile(file) as { servers?: Record<string, unknown> };
  const servers = { ...(parsed.servers ?? {}) };
  const existing = (servers[entry.name] as Record<string, unknown>) ?? {};
  const next: Record<string, unknown> = { ...existing };
  if (entry.url) {
    next.url = entry.url;
    delete next.command;
    delete next.args;
  } else {
    next.command = entry.command ?? existing.command ?? "";
    next.args = entry.args ?? [];
    delete next.url;
  }
  if (entry.disabled) next.disabled = true;
  else delete next.disabled;
  servers[entry.name] = next;
  writeJsonFile(file, { ...parsed, servers });
}

export function removeMcpServer(cwd: string, scope: "user" | "project", name: string): void {
  const file = mcpFile(scope, cwd);
  const parsed = readJsonFile(file) as { servers?: Record<string, unknown> };
  if (!parsed.servers || !(name in parsed.servers)) return;
  const servers = { ...parsed.servers };
  delete servers[name];
  writeJsonFile(file, { ...parsed, servers });
}

/* ---------- skills (slash commands) ---------- */

export interface SkillEntry {
  name: string;
  description: string;
  argumentHint: string;
  scope: "user" | "project";
  body: string;
}

function skillsDir(scope: "user" | "project", cwd: string): string {
  return scope === "project" ? join(cwd, ".prometheus", "commands") : join(CONFIG_HOME, "commands");
}

/** Split optional frontmatter from the body, matching src/commands.ts. */
function parseSkill(name: string, text: string, scope: "user" | "project"): SkillEntry {
  let description = "";
  let argumentHint = "";
  let body = text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
      if (!field) continue;
      const value = field[2].replace(/^["']|["']$/g, "");
      if (field[1] === "description") description = value;
      else if (field[1] === "argument-hint") argumentHint = value;
    }
  }
  return { name, description, argumentHint, scope, body: body.trim() };
}

export function listSkills(cwd: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const scope of ["user", "project"] as const) {
    const dir = skillsDir(scope, cwd);
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -3).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) continue;
      try {
        out.push(parseSkill(name, readFileSync(join(dir, file), "utf8"), scope));
      } catch {
        /* skip unreadable skills */
      }
    }
  }
  return out;
}

export function saveSkill(cwd: string, skill: SkillEntry): void {
  const name = skill.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) throw new Error("skill names use lowercase letters, digits, - and _");
  const dir = skillsDir(skill.scope, cwd);
  mkdirSync(dir, { recursive: true });
  const front: string[] = [];
  if (skill.description.trim()) front.push(`description: ${skill.description.trim()}`);
  if (skill.argumentHint.trim()) front.push(`argument-hint: ${skill.argumentHint.trim()}`);
  const text = `${front.length ? `---\n${front.join("\n")}\n---\n` : ""}${skill.body.trim()}\n`;
  writeFileSync(join(dir, `${name}.md`), text, "utf8");
}

export function removeSkill(cwd: string, scope: "user" | "project", name: string): void {
  const file = join(skillsDir(scope, cwd), `${name.toLowerCase()}.md`);
  if (existsSync(file)) rmSync(file, { force: true });
}

/* ---------- instructions ---------- */

const INSTRUCTION_FILE = join(CONFIG_HOME, "instructions.md");

export function readInstructions(): string {
  try {
    return existsSync(INSTRUCTION_FILE) ? readFileSync(INSTRUCTION_FILE, "utf8") : "";
  } catch {
    return "";
  }
}

export function writeInstructions(text: string): void {
  mkdirSync(CONFIG_HOME, { recursive: true });
  writeFileSync(INSTRUCTION_FILE, String(text ?? ""), "utf8");
}
