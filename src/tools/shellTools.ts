/** Shell execution with a timeout and combined output, plus the todo-list tool. */

import { spawn } from "node:child_process";
import { captureBashChanges, dirtyState } from "../gitSnapshot.ts";
import type { Tool, ToolResult, TodoItem } from "../types.ts";
import { resolveSafePath } from "../permissions.ts";
import { SandboxError, classifyCommand, sandboxEnv, shellFor, type SandboxPolicy } from "../sandbox.ts";
import { trimToolOutput } from "../context.ts";
import { spillToolOutput } from "../spill.ts";
import { jobContainmentSupported, killTree, openJob, type JobHandle } from "../winsandbox.ts";
import { availability, run as runKernel } from "../kernelSandbox.ts";

const DEFAULT_TIMEOUT = 120_000;

function sandboxHint(violations: string[]): string {
  if (violations.length === 0) return "";
  return `Offending: ${violations.slice(0, 3).join(", ")}. Rewrite the command to stay inside the workspace, or let the user run it.`;
}

export { SandboxError };
const MAX_OUTPUT = 120_000;

/**
 * Commands that can change files on disk.
 *
 * A conservative list on purpose: matching too much only costs a `git status`
 * (a few milliseconds), while matching too little silently loses the ability
 * to undo. Common read-only commands are excluded so the check is not paid on
 * every `cat`.
 */
const MUTATING_PROGRAMS = new Set([
  "rm", "del", "erase", "rd", "rmdir", "mv", "move", "ren", "rename", "cp", "copy", "xcopy", "robocopy", "sed", "perl", "python", "python3", "node", "npm", "npx", "pnpm", "yarn", "cargo", "make", "cmake", "ninja", "gradle", "mvn", "dotnet", "go", "rustc", "gcc", "clang", "tsc", "eslint", "prettier", "black", "ruff",
]);

/**
 * Read-only git subcommands, which change nothing and need no snapshot.
 */
const READONLY_GIT = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config", "rev-parse", "ls-files", "describe", "blame",
]);

/**
 * Does this command line run something that can write to disk?
 *
 * Token-based rather than one monolithic regular expression: a command can
 * be quoted, prefixed, or chained, and the first word of each segment is
 * what decides. `git` is special because most of its subcommands are reads.
 */
function canWriteFiles(command: string): boolean {
  // Split on shell separators rather than matching one giant pattern: the
  // first word of each segment is the program, and `git status && rm x` has
  // two segments with different answers.
  const segments = command.split(/&&|\|\||;|\n/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).map((word) => word.replace(/^["']+|["']+$/g, ""));
    // Skip a leading env assignment or `sudo`-style wrapper.
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || words[index] === "sudo")) index += 1;
    const raw = words[index] ?? "";
    const program = (raw.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
    if (!program) continue;
    if (program === "git") {
      const sub = (words[index + 1] ?? "").toLowerCase();
      if (!READONLY_GIT.has(sub)) return true;
      continue;
    }
    if (MUTATING_PROGRAMS.has(program)) return true;
  }
  return false;
}

/** A redirect to a path (`cmd > file`, `cmd >> file`) counts as a write. */
const REDIRECT_WRITE = /(^|[^0-9&])>>?\s*[^\s&|>]/;

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
  // The approval prompt has to show the command, not the model's description
  // of it. `description` was preferred, so a call could say "run tests" and
  // execute anything: the user approved a sentence, not a command line. The
  // description is appended only as a trailing hint, after the real text.
  summarize: (input) => {
    const command = String(input.command ?? "").replace(/\s+/g, " ").trim();
    const hint = typeof input.description === "string" && input.description.trim() ? ` — ${input.description.trim()}` : "";
    return `${command.slice(0, 120)}${hint}`.slice(0, 200);
  },
  persistOutput: true,
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = resolveSafePath(String(input.cwd ?? "."), ctx.cwd, ctx.config.allowedDirs);
    const command = String(input.command);
    const timeout = Math.min(600_000, Math.max(1000, Number(input.timeout_ms ?? DEFAULT_TIMEOUT)));

    const policy: SandboxPolicy = {
      mode: ctx.config.sandbox ?? "enforce",
      network: ctx.config.networkPolicy ?? "off",
      allowedDirs: ctx.config.allowedDirs ?? [],
      ...(ctx.config.sandboxCredentials ? { credentials: ctx.config.sandboxCredentials } : {}),
    };
    // The kernel sandbox, when the user enabled it. `wsl` refuses to fall back
    // — the point of choosing it is that a run which cannot be confined does
    // not happen — while `auto` uses WSL when it is there and stays on the
    // policy path when it is not.
    const kernelMode = ctx.config.kernelSandbox ?? "auto";
    let kernelDistro: string | undefined;
    if (kernelMode !== "off") {
      const status = await availability({ ...(ctx.config.kernelSandboxDistro ? { distro: ctx.config.kernelSandboxDistro } : {}) });
      if (status.state === "ready") kernelDistro = status.distro;
      else if (kernelMode === "wsl") {
        return {
          isError: true,
          content:
            `The kernel sandbox is required but unavailable: ${status.reason ?? "WSL is not ready"}. ` +
            "Install WSL (`wsl --install`) or set kernelSandbox to \"off\" to run on Windows with the policy sandbox only.",
          display: "sandbox unavailable",
        };
      }
    }

    // Inside WSL the command's paths are Linux paths, so the workspace is
    // `/mnt/g/...` and Windows semantics would reject every absolute path the
    // command legitimately uses. The verdict below has to be reached in the
    // same path space the command will run in.
    const pathFlavor = kernelMode !== "off" && kernelDistro ? "posix" : "windows";
    const verdict = classifyCommand(command, ctx.cwd, policy, { paths: pathFlavor });
    if (verdict.class === "deny") {
      return {
        isError: true,
        content: `Blocked by the command sandbox: ${verdict.reason}. ${sandboxHint(verdict.violations)}`,
        display: "blocked",
      };
    }

    // A run that requires OS containment must not quietly continue under the
    // policy layer alone: the caller asked for a stronger guarantee than the
    // classifier can give, and silently downgrading it is the failure mode the
    // setting exists to prevent.
    if (ctx.config.sandboxFailIfUnavailable && jobContainmentSupported() && policy.mode !== "off") {
      const available = await openJob()
        .then((handle) => {
          handle?.dispose();
          return handle !== null;
        })
        .catch(() => false);
      if (!available) {
        return {
          isError: true,
          content:
            "the OS-level command sandbox could not be created, and this session is configured to refuse rather than fall back. " +
            "Run the command yourself, or turn off sandboxFailIfUnavailable.",
          display: "sandbox unavailable",
        };
      }
    }

    // Git sees the files a command changes before the command runs, which is
    // the only moment their prior content is still reachable. Doing this only
    // for mutating commands keeps a read-only `git status` free.
    let snapshotBefore: Awaited<ReturnType<typeof dirtyState>> = null;
    if (ctx.sessionId && (canWriteFiles(command) || REDIRECT_WRITE.test(command))) {
      try {
        snapshotBefore = await dirtyState(cwd);
      } catch {
        snapshotBefore = null;
      }
    }

    if (kernelMode !== "off" && kernelDistro) {
      {
        const started = Date.now();
        const result = await runKernel(
          {
            command,
            cwd,
            network: policy.network === "open" ? "open" : "off",
            // A command that can write gets a read-write workspace; anything
            // else gets the read-only bind, which is the tighter of the two
            // and costs a build nothing it did not already need permission
            // for. The classifier has already allowed or confirmed the run.
            writable: canWriteFiles(command) || REDIRECT_WRITE.test(command),
            timeoutMs: timeout,
            ...(policy.credentials ? { env: policy.credentials } : {}),
          },
          { distro: kernelDistro, signal: ctx.signal },
        );
        const body = result.output ? trimToolOutput(result.output, 30_000) : "(no output)";
        const pointer = (content: string): string => {
          const path = spillToolOutput(ctx.sessionId ?? "", "bash", result.output);
          return path ? `${content}\n\n[full output: ${path}]` : content;
        };
        if (snapshotBefore && ctx.sessionId) {
          void captureBashChanges(ctx.sessionId, cwd, snapshotBefore).catch(() => {});
        }
        void started;
        if (result.timedOut) {
          return { isError: true, content: pointer(`${body}\n[timed out after ${timeout / 1000}s]`), display: "timed out" };
        }
        if (result.code === 0) return { content: pointer(body), display: "exit 0" };
        // 97 is the wrapper's own "could not enforce read-only" refusal.
        if (result.code === 97) {
          return { isError: true, content: pointer(`${body}\n[kernel sandbox refused to run]`), display: "sandbox refused" };
        }
        return { isError: true, content: pointer(`${body}\n[exit code ${result.code}]`), display: `exit ${result.code}` };
      }
    }

    return new Promise<ToolResult>(async (resolve) => {
      const { shell, args } = shellFor(command, policy);
      const child = spawn(shell, args, {
        cwd,
        env: sandboxEnv(policy),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // The policy layer judges the command line; the job stops the process
      // tree from outliving the call. A build that leaves a watcher running, or
      // an install whose postinstall keeps going after the turn is aborted, was
      // surviving because `child.kill()` only reaches the direct child.
      //
      // Assignment happens after the child exists, so a command that finishes
      // in a few milliseconds can complete before the job is ready; that window
      // is why `killAll` falls back to `taskkill /T` when no handle exists yet.
      let job: JobHandle | null = null;
      // Set when the tool is already finished, so a host that opens afterwards
      // is closed instead of leaked. `openJob` spawns a PowerShell process per
      // call; without this every fast command left one behind.
      let done = false;
      if (jobContainmentSupported() && policy.mode !== "off") {
        void openJob()
          .then(async (handle) => {
            if (!handle) return;
            if (done || !child.pid) {
              handle.dispose();
              return;
            }
            job = handle;
            if (!handle.assign(child.pid)) {
              handle.dispose();
              job = null;
            }
          })
          .catch(() => {
            /* containment is optional; the direct kill still runs */
          });
      }

      const killAll = () => {
        // The job reaches grandchildren; the fallback does too through taskkill,
        // but only while the direct child is still alive to anchor the tree.
        if (job) job.terminate();
        else killTree(child.pid);
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      };

      // Keep everything up to a generous cap and trim at the end instead of
      // dropping the tail as it arrives: a compiler's error summary is the
      // last thing it prints, and the old streaming cut removed exactly that.
      let output = "";
      let dropped = 0;
      let settled = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (output.length + text.length > MAX_OUTPUT) {
          const room = MAX_OUTPUT - output.length;
          output += text.slice(0, Math.max(0, room));
          dropped += text.length - Math.max(0, room);
          return;
        }
        output += text;
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        done = true;
        if (snapshotBefore && ctx.sessionId) {
          // Fire-and-forget: the command's result is what the model needs;
          // the snapshot is for a later undo and must not slow it down.
          void captureBashChanges(ctx.sessionId, cwd, snapshotBefore).catch(() => {});
        }
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        // A finished command still has a live job handle. Closing it is what
        // guarantees nothing it spawned is left behind.
        if (job) {
          job.terminate();
          job.dispose();
        }
        resolve(result);
      };

      const onAbort = () => {
        killAll();
        finish({ isError: true, content: `${output}\n[interrupted]`.trim() });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        killAll();
        finish({ isError: true, content: `${output}\n[timed out after ${timeout / 1000}s]`.trim() });
      }, timeout);

      child.on("error", (err) => finish({ isError: true, content: `Failed to run command: ${err.message}` }));
      child.on("close", (code) => {
        const body = output ? trimToolOutput(output, 30_000) : "(no output)";
        const tail = dropped > 0 ? `\n[${dropped} more characters were not captured]` : "";
        // The full output goes to disk when it is long, so a failure whose
        // explanation sits past the cap can be read back instead of re-run.
        const full = output;
        const withPointer = (content: string): string => {
          const path = spillToolOutput(ctx.sessionId ?? "", "bash", full);
          return path ? `${content}\n\n[full output: ${path}]` : content;
        };
        if (code === 0) {
          finish({ content: withPointer(`${body}${tail}`), display: `exit 0` });
        } else {
          finish({ isError: true, content: withPointer(`${body}${tail}\n[exit code ${code}]`), display: `exit ${code}` });
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
