import type { Tool } from "../types.ts";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globTool,
  grepTool,
} from "./fileTools.ts";
import { bashTool, todoTool } from "./shellTools.ts";
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

const subagentTool: Tool = {
  name: "delegate",
  description:
    "Run an independent sub-task in a fresh context with its own tool access, and return only a final report. Use it for broad searches or self-contained work that would otherwise flood your context. The sub-agent cannot ask the user questions; give it a complete, self-contained prompt.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Self-contained task description, including what to return" },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.prompt ?? "").slice(0, 100),
  async execute(input, ctx) {
    const report = await ctx.runSubagent(String(input.prompt));
    return { content: report, display: "sub-agent finished" };
  },
};

/** Tools available to the sub-agent: no nested delegation. */
export const SUBAGENT_TOOLS: Tool[] = [
  readFileTool,
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
  writeFileTool,
  editFileTool,
  listFilesTool,
  globTool,
  grepTool,
  bashTool,
  todoTool,
  memoryTool,
  subagentTool,
];

export function toolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}
