import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Tool, ToolResult } from "../types.ts";
import { resolveSafePath } from "../permissions.ts";
import { readTextFile, relPath, withLineNumbers } from "./fsUtil.ts";

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

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact text occurrence in a file. old_string must match byte-for-byte, including indentation, and must be unique unless replace_all is true. Prefer small, surgical edits over rewriting files.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.path ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const abs = resolveSafePath(String(input.path), ctx.cwd, ctx.config.allowedDirs);
    const oldString = String(input.old_string ?? "");
    const newString = String(input.new_string ?? "");
    if (oldString === newString) return { isError: true, content: "old_string and new_string are identical" };
    if (oldString === "") return { isError: true, content: "old_string must not be empty" };

    const { readTextFile: read, writeTextFile: write } = await import("./fsUtil.ts");
    const text = await read(abs);

    const indexes: number[] = [];
    let from = 0;
    for (;;) {
      const idx = text.indexOf(oldString, from);
      if (idx === -1) break;
      indexes.push(idx);
      from = idx + oldString.length;
    }
    if (indexes.length === 0) {
      return {
        isError: true,
        content: `old_string not found in ${input.path}. It must match exactly, including whitespace. Re-read the file and copy the exact text.`,
      };
    }
    if (indexes.length > 1 && !input.replace_all) {
      const shown = indexes.slice(0, 5).map((i) => text.slice(0, i).split("\n").length);
      return {
        isError: true,
        content: `old_string is ambiguous (${indexes.length} matches at lines ${shown.join(", ")}). Add more context or set replace_all.`,
      };
    }

    const updated = input.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    await write(abs, updated);
    const replaced = input.replace_all ? indexes.length : 1;
    return {
      content: `Edited ${relPath(abs, ctx.cwd)}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.`,
      display: `${replaced} occurrence${replaced === 1 ? "" : "s"} replaced`,
    };
  },
};

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
