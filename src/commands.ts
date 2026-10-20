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

/**
 * The commands the app itself implements.
 *
 * The composer's `/` menu listed only files from `commands/`, so a user who
 * had never written one saw an empty menu — the built-ins existed (the
 * renderer's command palette had them) but were not part of the list the menu
 * reads. These carry an empty `body`: a name here is not a prompt template,
 * it is a verb the host handles.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint: string }> = [
  { name: "clear", description: "Start a new conversation", argumentHint: "" },
  { name: "compact", description: "Compact the conversation, optionally with a focus", argumentHint: "[focus]" },
  { name: "context", description: "What is filling the context window", argumentHint: "" },
  { name: "cost", description: "Tokens and dollars spent this session", argumentHint: "" },
  { name: "effort", description: "Change the reasoning level", argumentHint: "[level]" },
  { name: "export", description: "Save this conversation as Markdown", argumentHint: "" },
  { name: "init", description: "Write a PROMETHEUS.md for this project", argumentHint: "" },
  { name: "memory", description: "Show the memory and instruction files in use", argumentHint: "" },
  { name: "mode", description: "Change the permission mode", argumentHint: "[mode]" },
  { name: "model", description: "Switch the model", argumentHint: "[id]" },
  { name: "models", description: "List the models the endpoint advertises", argumentHint: "[refresh]" },
  { name: "plan", description: "Plan before changing anything", argumentHint: "" },
  { name: "rewind", description: "Undo the last turns and restore their files", argumentHint: "[n]" },
  { name: "sessions", description: "List saved conversations", argumentHint: "" },
  { name: "usage", description: "Token usage by model and day", argumentHint: "" },
];

/** Merge global and project commands; a project command overrides its global twin. */
export function listCommands(cwd: string): Command[] {
  const merged = new Map<string, Command>();
  // Built-ins first, so a markdown file of the same name replaces one instead
  // of appearing twice.
  for (const builtin of BUILTIN_COMMANDS) {
    merged.set(builtin.name, { ...builtin, body: "", source: "builtin" });
  }
  for (const command of readDir(join(CONFIG_HOME, "commands"), "global")) merged.set(command.name, command);
  for (const command of readDir(join(cwd, ".prometheus", "commands"), "project")) merged.set(command.name, command);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True for a name that names a built-in rather than a markdown template. */
export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((command) => command.name === name.replace(/^\//, "").toLowerCase());
}

export function findCommand(cwd: string, name: string): Command | null {
  const wanted = name.replace(/^\//, "").toLowerCase();
  // A built-in is a verb the host handles, not a prompt template; returning it
  // here would expand to its empty body and send an empty message.
  if (isBuiltinCommand(wanted)) return null;
  return listCommands(cwd).find((command) => command.name === wanted) ?? null;
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
