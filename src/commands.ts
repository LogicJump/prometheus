/**
 * Custom slash commands.
 *
 * A command is one markdown file per directive, discovered from (highest
 * precedence last):
 *
 *   ~/.prometheus/commands/<name>.md
 *   <workspace>/.prometheus/commands/<name>.md
 *
 * The file body is the prompt. Frontmatter is optional:
 *
 *   ---
 *   description: Review the current diff
 *   argument-hint: [path]
 *   ---
 *   Review the changes in $ARGUMENTS.
 *
 * `$ARGUMENTS` is replaced with the text typed after the command; if the body
 * has no placeholder the arguments are appended as a final paragraph.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface Command {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  source: string;
}

function parseFile(name: string, text: string, source: string): Command {
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
  return { name, description, argumentHint, body: body.trim(), source };
}

function readDir(dir: string, origin: string): Command[] {
  if (!existsSync(dir)) return [];
  const out: Command[] = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) continue;
    try {
      out.push(parseFile(name, readFileSync(join(dir, file), "utf8"), `${origin}/${file}`));
    } catch {
      /* skip unreadable commands */
    }
  }
  return out;
}

/** Merge global and project commands; a project command overrides its global twin. */
export function listCommands(cwd: string): Command[] {
  const merged = new Map<string, Command>();
  for (const command of readDir(join(CONFIG_HOME, "commands"), "global")) merged.set(command.name, command);
  for (const command of readDir(join(cwd, ".prometheus", "commands"), "project")) merged.set(command.name, command);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCommand(cwd: string, name: string): Command | null {
  return listCommands(cwd).find((command) => command.name === name.replace(/^\//, "").toLowerCase()) ?? null;
}

/** Expand a command with the text typed after it. */
export function expandCommand(command: Command, args: string): string {
  const suffix = args.trim();
  if (command.body.includes("$ARGUMENTS")) {
    return command.body.split("$ARGUMENTS").join(suffix);
  }
  return suffix ? `${command.body}\n\n${suffix}` : command.body;
}

/**
 * If `text` starts with a known slash command, return the expanded prompt;
 * otherwise return null so the text can be sent as an ordinary message.
 */
export function expandSlash(cwd: string, text: string): { command: Command; prompt: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-_]*)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const command = findCommand(cwd, match[1]);
  if (!command) return null;
  return { command, prompt: expandCommand(command, match[2]) };
}
