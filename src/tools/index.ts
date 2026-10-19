import type { Tool } from "../types.ts";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globTool,
  grepTool,
  searchCodeTool,
} from "./fileTools.ts";
import { bashTool, todoTool } from "./shellTools.ts";
import { askUserTool } from "./askUser.ts";
import { embeddedTools } from "./embeddedTools.ts";
import { workerTool, workerLogTool } from "./workerTools.ts";
import { browserTools } from "./browserTools.ts";
import { saveMemory } from "../memory.ts";

const memoryTool: Tool = {
  name: "remember",
  description:
    "Persist a durable fact about the user, their preferences, or this project across sessions. Only save things that will still matter later; never save transient task state.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short kebab-case identifier" },
      description: { type: "string", description: "One-line summary" },
      type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
      body: { type: "string", description: "The fact itself, in markdown" },
    },
    required: ["name", "body"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.name ?? ""),
  async execute(input) {
    const file = saveMemory({
      name: String(input.name),
      description: String(input.description ?? ""),
      type: (input.type as "user" | "feedback" | "project" | "reference") ?? "project",
      body: String(input.body),
    });
    return { content: `Saved to ${file}`, display: "saved" };
  },
};

export const subagentTool: Tool = {
  name: "delegate",
  description:
    "Run independent sub-tasks in fresh contexts with their own tool access, returning only final reports. Use `prompt` for one task, or `prompts` to run up to four independent tasks in parallel. Set `background: true` for a long task whose report is not needed to continue; you will be told when it finishes. Use it for broad searches or self-contained work that would otherwise flood your context. Sub-agents cannot ask the user questions; give each a complete, self-contained prompt.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run", "list", "message", "stop", "report"],
        description:
          "run (default) starts a task; list shows sub-agents; message sends one of them another instruction; stop cancels one; report returns its latest full report.",
      },
      id: { type: "string", description: "Sub-agent id, for message/stop/report" },
      context: {
        type: "string",
        enum: ["none", "summary", "full"],
        description:
          "How much of this conversation the child starts with. none (default) keeps its context small; summary carries a digest; full forks the recent transcript.",
      },
      prompt: { type: "string", description: "Self-contained task description, including what to return" },
      prompts: {
        type: "array",
        description: "Several independent sub-tasks to run in parallel (max 4). Results come back in order.",
        items: { type: "string" },
        maxItems: 4,
      },
      background: {
        type: "boolean",
        description: "Run without blocking this turn. The report arrives as a notice when it finishes.",
      },
    },
    additionalProperties: false,
  },
  summarize: (input) => {
    const many = Array.isArray(input.prompts) ? input.prompts.length : 0;
    if (many > 0) return `${many} sub-tasks in parallel`;
    return String(input.prompt ?? "").slice(0, 100);
  },
  async execute(input, ctx) {
    const action = String(input.action ?? "run");
    const context = (String(input.context ?? "none") as "none" | "summary" | "full");
    if (action !== "run") {
      const registry = ctx.subagents;
      if (!registry) return { isError: true, content: "sub-agent management is not available in this session" };
      const id = String(input.id ?? "").trim();
      if (action === "list") {
        const rows = registry.list();
        return {
          content: rows.length
            ? rows
                .map((row) => `${row.id}  ${row.status.padEnd(7)} ${row.context.padEnd(7)} ${row.turns} turns  ${row.label}`)
                .join("\n")
            : "No sub-agents have been started in this session.",
          display: `${rows.length} sub-agents`,
        };
      }
      if (!id) return { isError: true, content: `action "${action}" needs an id; use action list to see them` };
      if (action === "report") {
        const report = registry.report(id);
        return report === null
          ? { isError: true, content: `no sub-agent with id ${id}` }
          : { content: report || "(no report yet)", display: id };
      }
      if (action === "stop") {
        return registry.stop(id)
          ? { content: `Stopped ${id}.`, display: "stopped" }
          : { isError: true, content: `no running sub-agent with id ${id}` };
      }
      // message
      const text = String(input.prompt ?? "").trim();
      if (!text) return { isError: true, content: "action message needs a prompt" };
      const report = await registry.message(id, text);
      return { content: report, display: `${id} replied` };
    }
    const prompts = Array.isArray(input.prompts) ? input.prompts.map(String).filter(Boolean).slice(0, 4) : [];
    if (prompts.length > 0) {
      if (!ctx.runSubagents) {
        return { isError: true, content: "parallel sub-agents are not available in this session" };
      }
      const results = await ctx.runSubagents(prompts, { context });
      const sections = results.map((result, index) => {
        const header = `## Sub-task ${index + 1}${result.ok ? "" : " (failed)"}`;
        return `${header}\n${result.report}`;
      });
      const failed = results.filter((result) => !result.ok).length;
      return {
        content: sections.join("\n\n"),
        display: failed ? `${failed}/${results.length} failed` : `${results.length} finished`,
        isError: failed === results.length,
      };
    }
    const single = String(input.prompt ?? "").trim();
    if (!single) return { isError: true, content: "Provide a prompt or a prompts array." };
    if (input.background === true) {
      if (!ctx.runSubagentInBackground) {
        return { isError: true, content: "background sub-agents are not available in this session" };
      }
      const started = ctx.runSubagentInBackground(single);
      if (!started) return { isError: true, content: "too many background sub-agents are already running" };
      return { content: "Started in the background. Its report will be delivered when it finishes.", display: "background" };
    }
    const report = await ctx.runSubagent(single, { context });
    return { content: report, display: "sub-agent finished" };
  },
};

/** Tools available to the sub-agent: no nested delegation. */
export const SUBAGENT_TOOLS: Tool[] = [
  readFileTool,
  searchCodeTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globTool,
  grepTool,
  bashTool,
  todoTool,
];

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  searchCodeTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globTool,
  grepTool,
  bashTool,
  todoTool,
  memoryTool,
  workerTool,
  workerLogTool,
  ...browserTools,
  subagentTool,
  ...embeddedTools,
  askUserTool,
];

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}
