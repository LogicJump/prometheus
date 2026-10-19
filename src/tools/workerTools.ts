import type { Tool } from "../types.ts";
import { listWorkers, readWorkerLog, startDetachedWorker } from "../workers.ts";

/**
 * Start a command that outlives the turn.
 *
 * Every foreground command dies with the turn that started it — the pipeline
 * aborts running tools when the user interrupts, and a tool call has a
 * timeout. A build that takes twenty minutes, a soak test, a watch loop: these
 * need a process of their own, and the user needs to be able to check on it
 * from a later turn or another terminal.
 *
 * The tool starts one and returns immediately. It does not stream output back
 * (a long-running command would fill the context); `worker_log` reads the tail
 * on demand, and the worker's record says whether it is still going.
 */
export const workerTool: Tool = {
  name: "worker",
  description:
    "Run a long command in the background, in its own process, and return at once with a worker id. Use it for builds, test suites, soak runs, or anything that should survive the turn. Check on it later with worker_log. The command still goes through the command sandbox rules when it is started.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run in the background" },
      cwd: { type: "string", description: "Working directory relative to the workspace root (default: the workspace)" },
      timeout_ms: {
        type: "integer",
        description: "Optional stop after this many milliseconds; omitted means run until it exits",
      },
      description: { type: "string", description: "One line describing the task, shown in the worker list" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.description || input.command || "background command").slice(0, 120),
  async execute(input, ctx) {
    const command = String(input.command ?? "").trim();
    if (!command) return { isError: true, content: "Provide a command to run in the background." };

    // The unit of approval is the command line, not the tool name: the user
    // approved a sentence that runs a build, not "any command, ever".
    const verdict = await ctx.permissions.check(
      { ...workerTool, name: "bash" },
      { command, ...(input.cwd ? { cwd: input.cwd } : {}) },
    );
    if (!verdict.allowed) {
      return { isError: true, content: `Error: ${verdict.reason ?? "permission denied"}. Do not retry; adjust your approach.` };
    }

    const timeout = Number(input.timeout_ms);
    const wrapped =
      Number.isFinite(timeout) && timeout > 0
        ? process.platform === "win32"
          ? `timeout /t ${Math.ceil(timeout / 1000)} /nobreak >nul & ${command}`
          : `timeout ${Math.ceil(timeout / 1000)} ${command}`
        : command;

    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : ctx.cwd;
    try {
      const id = startDetachedWorker({ command: wrapped, cwd, note: String(input.description ?? "") });
      return {
        content:
          `Started in the background as ${id}.\n` +
          `It keeps running after this turn. Follow it with \`prometheus attach ${id}\`, ` +
          `list workers with \`prometheus workers\`, or ask me to read its log.`,
        display: id,
      };
    } catch (err) {
      return { isError: true, content: `could not start the background command: ${(err as Error).message}` };
    }
  },
};

/** Read a worker's log tail, or list the workers when no id is given. */
export const workerLogTool: Tool = {
  name: "worker_log",
  description:
    "Read the recent output of a background worker started with the worker tool, or list all workers and their state when no id is given. Use it to check whether a long build finished.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Worker id; omit to list every worker" },
      bytes: { type: "integer", description: "How much of the tail to read (default 16384)" },
    },
    additionalProperties: false,
  },
  summarize: (input) => (input.id ? `worker ${input.id}` : "list workers"),
  async execute(input) {
    if (!input.id) {
      const records = listWorkers();
      if (records.length === 0) return { content: "No background workers have been started." };
      const lines = records.map((record) => {
        const took = record.endedAt
          ? `${Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000))}s`
          : "running";
        return `${record.id}  ${record.state}  ${took}  ${record.label}${record.summary ? `  — ${record.summary}` : ""}`;
      });
      return { content: lines.join("\n"), display: `${records.length} worker(s)` };
    }
    const text = readWorkerLog(String(input.id), Number(input.bytes) > 0 ? Number(input.bytes) : 16_384);
    if (text === null) return { isError: true, content: `No log for worker ${input.id}.` };
    return { content: text || "(the worker has not printed anything yet)", display: `worker ${input.id}` };
  },
};
