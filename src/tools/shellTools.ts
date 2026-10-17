/** Shell execution with a timeout and combined output, plus the todo-list tool. */

import { spawn } from "node:child_process";
import type { Tool, ToolResult, TodoItem } from "../types.ts";
import { resolveSafePath } from "../permissions.ts";

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the workspace. Use for builds, tests, git, and package managers. Commands run non-interactively; avoid anything that waits for input. Prefer tool calls over shell commands for reading and editing files.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run" },
      cwd: { type: "string", description: "Working directory relative to the workspace root" },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 120000, max 600000)" },
      description: { type: "string", description: "Short description of what this command does" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.description ?? input.command ?? "").slice(0, 120),
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = resolveSafePath(String(input.cwd ?? "."), ctx.cwd, ctx.config.allowedDirs);
    const command = String(input.command);
    const timeout = Math.min(600_000, Math.max(1000, Number(input.timeout_ms ?? DEFAULT_TIMEOUT)));

    return new Promise<ToolResult>((resolve) => {
      const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
      const child = spawn(shell, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let truncated = false;
      let settled = false;
      const append = (chunk: Buffer) => {
        if (truncated) return;
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT);
          truncated = true;
        }
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const onAbort = () => {
        child.kill();
        finish({ isError: true, content: `${output}\n[interrupted]`.trim() });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        child.kill();
        finish({ isError: true, content: `${output}\n[timed out after ${timeout / 1000}s]`.trim() });
      }, timeout);

      child.on("error", (err) => finish({ isError: true, content: `Failed to run command: ${err.message}` }));
      child.on("close", (code) => {
        const body = output || "(no output)";
        const tail = truncated ? "\n[output truncated at 30k characters]" : "";
        if (code === 0) {
          finish({ content: `${body}${tail}`, display: `exit 0` });
        } else {
          finish({ isError: true, content: `${body}${tail}\n[exit code ${code}]`, display: `exit ${code}` });
        }
      });
    });
  },
};

export const todoTool: Tool = {
  name: "todo_write",
  description:
    "Maintain the task plan for a multi-step job. Send the complete list each time, with exactly one item in_progress. Use this for any task with three or more steps; skip it for trivial one-step requests.",
  readonly: true, // bookkeeping only; safe in plan mode
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative description, e.g. 'Add input validation'" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  summarize: (input) => {
    const todos = (input.todos as { status?: string }[]) ?? [];
    const done = todos.filter((t) => t.status === "completed").length;
    return `${done}/${todos.length}`;
  },
  async execute(input, ctx): Promise<ToolResult> {
    const raw = (input.todos as { content?: string; status?: string }[]) ?? [];
    if (!Array.isArray(raw)) return { isError: true, content: "todos must be an array" };
    const items: TodoItem[] = raw.map((t, i) => ({
      id: String(i + 1),
      content: String(t.content ?? ""),
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
    }));
    ctx.todo.items = items;
    ctx.ui.todos(items);
    const active = items.filter((t) => t.status === "in_progress");
    return {
      content: `Plan updated: ${items.filter((t) => t.status === "completed").length}/${items.length} complete${
        active.length ? `; in progress: ${active[0].content}` : ""
      }`,
      display: `${items.filter((t) => t.status === "completed").length}/${items.length}`,
    };
  },
};
