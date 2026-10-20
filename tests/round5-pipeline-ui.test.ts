/**
 * The tool pipeline must call the UI object it was given.
 *
 * The regression this guards against is subtle: the constructor used to do
 * `{ ...SILENT_UI, ...deps.ui }`, which copies own properties only. A class
 * instance keeps its methods on the prototype, so every callback silently
 * became a no-op — `typeof ui.toolStart` was still "function", nothing threw,
 * and the transcript lost every tool row while tools ran normally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolPipeline } from "../src/tools/pipeline.ts";
import type { Tool, Ui } from "../src/types.ts";

/** A UI whose methods live on a prototype, exactly like the real HostUi. */
class PrototypeUi {
  calls: string[] = [];
  info() { this.calls.push("info"); }
  dim() {}
  warn() {}
  error() {}
  assistantText() {}
  assistantEnd() {}
  toolStart(name: string) { this.calls.push(`toolStart:${name}`); }
  toolEnd(name: string) { this.calls.push(`toolEnd:${name}`); }
  thinking() {}
  thinkingEnd() {}
  todos() {}
  async confirm() { return "no" as const; }
  spinnerStart() {}
  spinnerStop() {}
}

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  readonly: true,
  summarize: () => "echo",
  async execute(input) {
    return { content: String(input.text ?? "") };
  },
};

function pipelineWith(ui: unknown): ToolPipeline {
  return new ToolPipeline(
    () => [echoTool],
    {
      config: { permissionMode: "auto" } as never,
      ui: ui as Ui,
      permissions: { mode: "auto", check: async () => ({ allowed: true }) } as never,
      todos: { items: [] } as never,
      hooks: [],
      sessionId: "",
      cwd: process.cwd(),
      runSubagent: async () => "",
    } as never,
  );
}

test("a class instance keeps its prototype methods through the pipeline", async () => {
  const ui = new PrototypeUi();
  const pipeline = pipelineWith(ui);
  const outcome = await pipeline.run("echo", JSON.stringify({ text: "hi" }), new AbortController().signal);
  assert.equal(outcome.ok, true);
  // This is the assertion that fails when the UI is spread into a plain object.
  assert.deepEqual(ui.calls, ["toolStart:echo", "toolEnd:echo"]);
});

test("a partial UI double is filled in rather than rejecting", async () => {
  // Tests and headless callers pass only the methods they care about.
  const seen: string[] = [];
  const partial = { toolStart: (name: string) => seen.push(name) };
  const pipeline = pipelineWith(partial);
  const outcome = await pipeline.run("echo", JSON.stringify({ text: "hi" }), new AbortController().signal);
  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, ["echo"]);
});

test("a missing UI falls back to the silent one", async () => {
  const pipeline = new ToolPipeline(
    () => [echoTool],
    {
      config: { permissionMode: "auto" } as never,
      permissions: { mode: "auto", check: async () => ({ allowed: true }) } as never,
      todos: { items: [] } as never,
      hooks: [],
      sessionId: "",
      cwd: process.cwd(),
      runSubagent: async () => "",
    } as never,
  );
  const outcome = await pipeline.run("echo", JSON.stringify({ text: "hi" }), new AbortController().signal);
  assert.equal(outcome.ok, true);
});
