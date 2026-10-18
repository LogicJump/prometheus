/** Parallel sub-agents: concurrent children, ordered results, isolated failures. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "./fakeServer.ts";

async function makeAgent(scenario: Parameters<typeof startFakeServer>[0]) {
  const { Agent } = await import("../src/agent.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { Permissions } = await import("../src/permissions.ts");
  const fake = await startFakeServer(scenario);
  const config = {
    baseUrl: fake.url,
    apiKey: "test",
    model: "fake-model",
    maxTokens: 4000,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 6,
    allowedDirs: [],
    autoApprove: [],
  };
  const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "test", model: "fake-model", maxTokens: 4000 });
  const agent = new Agent(config, ui, client, undefined, new Permissions(config, ui), []);
  return { agent, fake };
}

test("delegate runs several sub-tasks in parallel and returns their reports in order", async () => {
  let active = 0;
  let peak = 0;
  const { agent, fake } = await makeAgent((body) => {
    const first = body.messages.find((message) => message.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    // The parent prompt asks for the batch; child prompts are the individual tasks.
    if (text.includes("batch")) {
      return {
        toolCalls: [
          {
            name: "delegate",
            args: JSON.stringify({ prompts: ["task alpha", "task beta", "task gamma"] }),
          },
        ],
      };
    }
    return { text: `report: ${text}` };
  });
  // Observe concurrency by wrapping the tool.
  const { subagentTool } = await import("../src/tools/index.ts");
  const result = await subagentTool.execute(
    { prompts: ["task alpha", "task beta", "task gamma"] },
    {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      config: { allowedDirs: [] },
      permissions: { mode: "auto", check: async () => ({ allowed: true }) },
      ui: { info() {}, subagentStart() {}, subagentActivity() {}, subagentEnd() {}, dim() {}, warn() {}, error() {} },
      todo: { items: [] },
      runSubagent: async (prompt: string) => `serial: ${prompt}`,
      runSubagents: async (prompts: string[]) => {
        active = prompts.length;
        peak = Math.max(peak, active);
        return prompts.map((prompt, index) => ({ ok: index !== 1, report: prompt === "task beta" ? "failed on purpose" : `report: ${prompt}` }));
      },
    } as never,
  );
  assert.equal(result.isError, false);
  assert.match(result.content, /^## Sub-task 1\nreport: task alpha/);
  assert.match(result.content, /## Sub-task 2 \(failed\)\nfailed on purpose/);
  assert.match(result.content, /## Sub-task 3\nreport: task gamma/);
  assert.equal(peak, 3, "all three ran in one batch");
  await fake.close();
});

test("the agent runs children concurrently and sums their usage", async () => {
  const { agent, fake } = await makeAgent((body) => {
    const first = body.messages.find((message) => message.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    return { text: `answer: ${text}` };
  });
  const started = Date.now();
  const results = await agent.runSubagentsForTest(["one", "two", "three"], new AbortController().signal);
  const elapsed = Date.now() - started;
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(
    results.map((result) => result.report),
    ["answer: one", "answer: two", "answer: three"],
  );
  // Each child costs 100 input tokens; the parent sees all three.
  assert.equal(agent.usage.inputTokens, 300);
  assert.ok(elapsed < 5_000, "children overlapped rather than running serially");
  await fake.close();
});
