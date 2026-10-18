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
import { embeddedTools } from "./embeddedTools.ts";
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
    const prompts = Array.isArray(input.prompts) ? input.prompts.map(String).filter(Boolean).slice(0, 4) : [];
    if (prompts.length > 0) {
      if (!ctx.runSubagents) {
        return { isError: true, content: "parallel sub-agents are not available in this session" };
      }
      const results = await ctx.runSubagents(prompts);
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
    const report = await ctx.runSubagent(single);
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
  subagentTool,
  ...embeddedTools,
];

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}
