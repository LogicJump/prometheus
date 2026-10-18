import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Tool, ToolResult } from "../types.ts";
import { resolveSafePath } from "../permissions.ts";
import { readTextFile, relPath, withLineNumbers } from "./fsUtil.ts";
import { diffFile } from "../diff.ts";
import { findMatch, parsePatch, reindent } from "./match.ts";

const LIMIT = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      offset: { type: "integer", description: "1-based line to start from", minimum: 1 },
      limit: { type: "integer", description: "Maximum lines to return", minimum: 1, maximum: LIMIT },
    },
    required: ["path"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.path ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path), ctx.cwd, ctx.config.allowedDirs);
    let text: string;
    try {
      text = await readTextFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const suggestions = await findSimilar(abs);
      return {
        isError: true,
        content: `File not found: ${input.path}${suggestions.length ? `\nDid you mean: ${suggestions.join(", ")}` : ""}`,
      };
    }
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.min(LIMIT, Number(input.limit ?? LIMIT));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + limit < lines.length;
    const body = withLineNumbers(slice.join("\n"), offset);
    return {
      content: truncated ? `${body}\n\n[truncated at ${offset + limit - 1}; file has ${lines.length} lines]` : body,
      display: `${relPath(abs, ctx.cwd)} (${lines.length} lines)`,
    };
  },
};

async function findSimilar(abs: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { dirname, basename } = await import("node:path");
  const dir = dirname(abs);
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir);
    const base = basename(abs).toLowerCase();
    return entries.filter((e) => e.toLowerCase().includes(base.slice(0, 6))).slice(0, 5);
  } catch {
    return [];
  }
}

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a file or overwrite it completely. For targeted changes to an existing file prefer edit_file. Parent directories are created as needed.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.path ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path), ctx.cwd, ctx.config.allowedDirs);
    const content = String(input.content ?? "");
    const { mkdir, stat } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(abs), { recursive: true });
    const existed = existsSync(abs);
    const { writeTextFile } = await import("./fsUtil.ts");
    await writeTextFile(abs, content);
    const lineCount = content.split("\n").length;
    return {
      content: `${existed ? "Updated" : "Created"} ${relPath(abs, ctx.cwd)} (${lineCount} lines, ${content.length} bytes)`,
      display: `${existed ? "updated" : "created"} ${lineCount} lines`,
    };
  },
};

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface AppliedEdit {
  rung: string;
  occurrences: number;
}

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Change a file with one or more search/replace edits. Provide old_string + new_string for a single edit, `edits` for an atomic batch, or `patch` with <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks. Matching tolerates CRLF, trailing whitespace, and differing indentation, but each search must resolve to exactly one place. All edits in one call succeed or nothing is written.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to find (single edit)" },
      new_string: { type: "string", description: "Replacement text (single edit)" },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_string" },
      edits: {
        type: "array",
        description: "Several edits applied in order, atomically",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
      patch: {
        type: "string",
        description: "One or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  summarize: (input) => {
    const count = Array.isArray(input.edits) ? input.edits.length : input.patch ? "patch" : 1;
    return `${input.path ?? ""}${typeof count === "number" && count > 1 ? ` (${count} edits)` : ""}`;
  },
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path), ctx.cwd, ctx.config.allowedDirs);
    const specs = collectEdits(input);
    if (typeof specs === "string") return { isError: true, content: specs };

    const { readTextFile: read, writeTextFile: write } = await import("./fsUtil.ts");
    const before = await read(abs);
    let text = before;
    const applied: AppliedEdit[] = [];

    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      if (!spec.old_string) return { isError: true, content: `edit ${index + 1}: old_string must not be empty` };
      if (spec.old_string === spec.new_string) {
        return { isError: true, content: `edit ${index + 1}: old_string and new_string are identical` };
      }

      const found = findMatch(text, spec.old_string, Boolean(spec.replace_all));
      if (!found.ok) {
        const where = found.failure.candidates.length > 0 ? ` Closest lines: ${found.failure.candidates.join(", ")}.` : "";
        const verdict = found.failure.reason === "ambiguous" ? "ambiguous" : "not found";
        return {
          isError: true,
          content: `edit ${index + 1} failed in ${input.path}: ${verdict} - ${found.failure.message}.${where} Nothing was written; re-read the file and retry.`,
        };
      }

      const { match } = found;
      const replacement = match.rung === "indent" ? reindent(match.matchedText, spec.old_string, spec.new_string) : spec.new_string;
      if (spec.replace_all) {
        const occurrences = text.split(match.matchedText).length - 1;
        text = text.split(match.matchedText).join(replacement);
        applied.push({ rung: match.rung, occurrences });
      } else {
        text = `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
        applied.push({ rung: match.rung, occurrences: 1 });
      }
    }

    if (text === before) return { content: `No change to ${input.path}.`, display: "unchanged" };
    await write(abs, text);

    const summary = diffFile(relPath(abs, ctx.cwd), before, text);
    const rungs = [...new Set(applied.map((entry) => entry.rung))];
    const softened = rungs.filter((rung) => rung !== "exact");
    return {
      content:
        `Edited ${relPath(abs, ctx.cwd)}: +${summary.additions} -${summary.deletions} in ${applied.length} edit(s).` +
        (softened.length ? ` Matching was tolerant on: ${softened.join(", ")}.` : ""),
      display: `+${summary.additions} -${summary.deletions}${softened.length ? ` (${softened.join("/")})` : ""}`,
    };
  },
};

/** Turn the three accepted input shapes into one ordered list of edits. */
function collectEdits(input: Record<string, unknown>): EditSpec[] | string {
  const fromPatch = typeof input.patch === "string" && input.patch.trim() ? parsePatch(input.patch) : [];
  const fromList = Array.isArray(input.edits) ? input.edits : [];
  const single =
    typeof input.old_string === "string"
      ? [{ old_string: input.old_string, new_string: String(input.new_string ?? ""), replace_all: Boolean(input.replace_all) }]
      : [];

  const specs: EditSpec[] = [];
  for (const block of fromPatch) specs.push({ old_string: block.search, new_string: block.replace });
  for (const entry of fromList) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    specs.push({
      old_string: String(item.old_string ?? ""),
      new_string: String(item.new_string ?? ""),
      replace_all: Boolean(item.replace_all),
    });
  }
  for (const spec of single) specs.push(spec);

  if (specs.length === 0) {
    return "Provide old_string + new_string, an `edits` array, or a `patch` with SEARCH/REPLACE blocks.";
  }
  return specs;
}

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files and directories under a path. Use to understand project layout before reading files.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to workspace root; defaults to the root" },
      depth: { type: "integer", description: "How many directory levels to show (default 2)", minimum: 1, maximum: 6 },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.path ?? "."),
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path ?? "."), ctx.cwd, ctx.config.allowedDirs);
    const { readdirSync, statSync } = await import("node:fs");
    const depth = Math.min(6, Number(input.depth ?? 2));
    const lines: string[] = [];
    const visit = (dir: string, level: number, prefix: string) => {
      if (level > depth) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
        if (entry.name === "node_modules") continue;
        const full = `${dir}/${entry.name}`;
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) visit(full, level + 1, `${prefix}  `);
      }
    };
    visit(abs, 1, "");
    if (lines.length === 0) return { content: "Directory is empty.", display: "empty" };
    return { content: lines.join("\n"), display: `${lines.length} entries` };
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files by glob pattern, e.g. **/*.ts or src/**/*.{js,ts}. Results are workspace-relative.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the workspace root" },
      limit: { type: "integer", description: "Maximum results (default 200)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.pattern ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const { globToRegExp, walk, relPath } = await import("./fsUtil.ts");
    const pattern = String(input.pattern).replace(/^\.\//, "");
    const re = globToRegExp(pattern);
    const limit = Math.min(1000, Number(input.limit ?? 200));
    const matches: string[] = [];
    for (const file of walk(ctx.cwd)) {
      const rel = relPath(file, ctx.cwd);
      if (re.test(rel)) {
        matches.push(rel);
        if (matches.length >= limit) break;
      }
    }
    if (matches.length === 0) return { content: `No files match ${pattern}`, display: "no matches" };
    return { content: matches.join("\n"), display: `${matches.length} files` };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep if installed, otherwise a JS fallback). Returns matching lines with paths and line numbers.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory to search; defaults to the workspace root" },
      glob: { type: "string", description: "Only search files matching this glob, e.g. **/*.ts" },
      case_insensitive: { type: "boolean" },
      max_results: { type: "integer", description: "Default 100" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  summarize: (input) => `/${String(input.pattern)}/ in ${String(input.path ?? ".")}`,
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path ?? "."), ctx.cwd, ctx.config.allowedDirs);
    const max = Math.min(500, Number(input.max_results ?? 100));
    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(max)];
    if (input.case_insensitive) rgArgs.push("-i");
    if (input.glob) rgArgs.push("--glob", String(input.glob));
    rgArgs.push("--", String(input.pattern), abs);

    const rg = await runRg(rgArgs, ctx.cwd);
    if (rg !== null) {
      if (rg.trim() === "") return { content: "No matches.", display: "no matches" };
      const lines = rg.trimEnd().split("\n").slice(0, max);
      const { relPath } = await import("./fsUtil.ts");
      const normalized = lines
        .map((line) => {
          const m = line.match(/^(.*?):(\d+):(.*)$/);
          if (!m) return line;
          const rel = relPath(m[1], ctx.cwd);
          return `${rel}:${m[2]}:${m[3].slice(0, 400)}`;
        })
        .join("\n");
      return { content: normalized, display: `${lines.length} matches` };
    }

    // Fallback: JS implementation.
    const { walk, readTextFileSync, globToRegExp, relPath } = await import("./fsUtil.ts");
    const flags = input.case_insensitive ? "i" : "";
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern), flags);
    } catch (err) {
      return { isError: true, content: `Invalid regex: ${(err as Error).message}` };
    }
    const globRe = input.glob ? globToRegExp(String(input.glob).replace(/^\.\//, "")) : null;
    const out: string[] = [];
    const searchFile = (file: string) => {
      const rel = relPath(file, ctx.cwd);
      if (globRe && !globRe.test(rel)) return;
      let text: string;
      try {
        text = readTextFileSync(file);
      } catch {
        return;
      }
      const fileLines = text.split("\n");
      for (let i = 0; i < fileLines.length && out.length < max; i++) {
        if (re.test(fileLines[i])) out.push(`${rel}:${i + 1}:${fileLines[i].slice(0, 400)}`);
      }
    };
    const { statSync } = await import("node:fs");
    let info;
    try {
      info = statSync(abs);
    } catch {
      return { isError: true, content: `Path not found: ${input.path}` };
    }
    if (info.isFile()) searchFile(abs);
    else for (const file of walk(abs)) {
      searchFile(file);
      if (out.length >= max) break;
    }
    if (out.length === 0) return { content: "No matches.", display: "no matches" };
    return { content: out.join("\n"), display: `${out.length} matches` };
  },
};

function runRg(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "rg.exe" : "rg",
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
          // ripgrep exits 1 when there are no matches
          if (stdout) return resolve(stdout);
          if (stderr && !/ENOENT/.test(stderr)) return resolve(null);
          return resolve(stdout ?? null);
        }
        resolve(stdout);
      },
    );
  });
}
