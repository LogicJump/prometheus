/** Markdown project instructions, loaded into the system prompt. */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const FILE_NAMES = ["PROMETHEUS.md", "AGENTS.md", "CLAUDE.md"];

/** Load the nearest instruction file, walking up from cwd, plus ~/.prometheus/instructions.md. */
export function loadProjectInstructions(): string {
  const parts: string[] = [];
  const globalFile = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".prometheus", "instructions.md");
  if (existsSync(globalFile)) {
    parts.push(readFileSync(globalFile, "utf8").trim());
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    for (const name of FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const rel = dir === process.cwd() ? name : join(basename(dirname(candidate)), basename(candidate));
        parts.push(`## ${rel}\n\n${readFileSync(candidate, "utf8").trim()}`);
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return parts.filter(Boolean).join("\n\n");
}
