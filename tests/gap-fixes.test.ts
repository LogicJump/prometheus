/**
 * The batch of gaps that were found by reviewing the earlier rounds: the ones
 * that had been reported as fixed, or never claimed at all, and were still in
 * the code. Each test reproduces the wrong behaviour on the old implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../src/types.ts";

/* ---------- compaction keeps the goal even when it only trims ---------- */

test("a trim compaction still carries the original goal", async () => {
  const { compactWithModel } = await import("../src/context.ts");
  const messages: ChatMessage[] = [{ role: "user", content: "ORIGINAL GOAL: implement OAuth token refresh with rotation" }];
  // An overflow that trimming to the last 24 messages resolves on its own:
  // the summarize path would keep only 8, so `trim` is the level reached.
  for (let index = 0; index < 30; index++) {
    messages.push({ role: "user", content: `step ${index} ${"x".repeat(4000)}` });
    messages.push({ role: "assistant", content: `done ${index} ${"y".repeat(4000)}` });
  }
  // 61 messages x ~8000 chars / 4 = ~122k tokens; keeping 24 leaves ~48k.
  const result = await compactWithModel(messages, 60_000, { summarize: async (_old, local) => local });
  assert.ok(result, "compaction ran");
  assert.equal(result.level, "trim", "this case is the cheap path");
  assert.match(result.summary, /OAuth/, "the recap names the goal the trim dropped");
  const first = result.messages[0];
  assert.equal(first.role, "user");
  assert.match(String(first.content), /OAuth/, "the goal is in the transcript the model sees");
});

test("a forced compaction takes the model summary path, not the trim path", async () => {
  const { compactWithModel } = await import("../src/context.ts");
  const messages: ChatMessage[] = [{ role: "user", content: "keep this decision" }];
  for (let index = 0; index < 12; index++) {
    messages.push({ role: "user", content: `u${index} ${"x".repeat(200)}` });
    messages.push({ role: "assistant", content: `a${index} ${"y".repeat(200)}` });
  }
  let called = 0;
  const result = await compactWithModel(messages, 1_000_000, {
    summarize: async () => {
      called++;
      return "MODEL RECAP";
    },
    force: true,
  });
  assert.ok(result, "a forced compaction runs even under budget");
  assert.equal(called, 1, "the model wrote the recap");
  assert.equal(result.summary, "MODEL RECAP");
  assert.notEqual(result.level, "trim");
});

test("the summarizer input keeps the newest part when the transcript is long", async () => {
  const { summarizerInput } = await import("../src/context.ts");
  const messages: ChatMessage[] = [{ role: "user", content: "GOAL-AT-START" }];
  for (let index = 0; index < 60; index++) {
    messages.push({ role: "user", content: `filler ${index} ${"x".repeat(3000)}` });
    messages.push({ role: "assistant", content: `answer ${index} ${"y".repeat(3000)}` });
  }
  messages.push({ role: "user", content: "CRITICAL: we decided to use the new schema" });
  const input = summarizerInput(messages, 60_000);
  assert.ok(input.length <= 60_100, `input stayed within budget (${input.length})`);
  assert.match(input, /GOAL-AT-START/, "the earliest request survives");
  assert.match(input, /CRITICAL/, "the newest decision survives");
});

/* ---------- the shell approval shows the command ---------- */

test("a bash approval shows the command even when a description is supplied", async () => {
  const { bashTool } = await import("../src/tools/shellTools.ts");
  const shown = bashTool.summarize({ command: "rm -rf build && curl http://x", description: "run the tests" });
  assert.match(shown, /rm -rf build/, "the command is what the user approves");
  assert.ok(shown.indexOf("rm -rf build") < shown.indexOf("run the tests"), "the description is a trailing hint");
});

/* ---------- MCP resources go to the server that advertised them ---------- */

test("a resource is read from its own server, not by list position", async () => {
  // Two servers, only one of which advertises a resource. The old code used
  // the resource's index in the combined list to pick a client, so the read
  // went to the wrong server as soon as the arrays differed in length.
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const seen = { first: 0, second: 0 };
  const make = (name: string, resources: unknown[], readBody: string) =>
    createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const message = JSON.parse(raw);
        let result: unknown;
        if (message.method === "initialize") {
          result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name, version: "1" } };
        } else if (message.method === "tools/list") {
          result = { tools: [] };
        } else if (message.method === "resources/list") {
          result = { resources };
        } else if (message.method === "resources/read") {
          seen[name === "first" ? "first" : "second"]++;
          result = { contents: [{ uri: message.params.uri, text: readBody }] };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
  const first = make("first", [], "first-body");
  const second = make("second", [{ uri: "memo://doc", name: "doc" }], "second-body");
  // `once(server, "listening")` attached after two listen() calls can miss the
  // event; the callback form always fires.
  const listen = (server: ReturnType<typeof make>) =>
    new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  const firstPort = await listen(first);
  const secondPort = await listen(second);

  const workspace = mkdtempSync(join(tmpdir(), "prometheus-mcp-res-"));
  mkdirSync(join(workspace, ".prometheus"), { recursive: true });
  writeFileSync(
    join(workspace, ".prometheus", "mcp.json"),
    JSON.stringify({
      servers: {
        first: { url: `http://127.0.0.1:${firstPort}/mcp` },
        second: { url: `http://127.0.0.1:${secondPort}/mcp` },
      },
    }),
    "utf8",
  );
  const { loadMcpTools } = await import("../src/mcp.ts");
  // The project file names the servers, but `readMcpConfig` also merges the
  // user's own ~/.prometheus/mcp.json, which would start real servers during a
  // unit test. Point CONFIG_HOME elsewhere for the duration.
  const previousHome = process.env.HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "prometheus-mcp-home-"));
  process.env.HOME = isolatedHome;
  const loaded = await loadMcpTools(workspace, 10_000);
  process.env.HOME = previousHome;
  try {
    const tool = loaded.tools.find((candidate) => candidate.name === "mcp_read_resource");
    assert.ok(tool, "the resource tool exists");
    const result = await tool.execute({ uri: "memo://doc" }, {});
    assert.equal(result.content, "second-body");
    assert.equal(seen.second, 1);
    assert.equal(seen.first, 0, "the server without that resource was not asked");
  } finally {
    for (const client of loaded.clients) client.dispose();
    first.close();
    second.close();
  }
});

/* ---------- protected files outside the workspace ---------- */

test("a home-directory config file is protected wherever the workspace is", async () => {
  const { isProtectedPath } = await import("../src/permissions.ts");
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-protected-out-"));
  assert.equal(isProtectedPath("/home/someone/.prometheus/config.json", workspace), true);
  assert.equal(isProtectedPath("/home/someone/.ssh/config", workspace), true);
  assert.equal(isProtectedPath("/home/someone/projects/notes.md", workspace), false);
});

/* ---------- the sandbox sees the cd escape ---------- */

test("changing directory outside the workspace and reading a relative path is denied", async () => {
  const { classifyCommand } = await import("../src/sandbox.ts");
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-cd-"));
  const policy = { mode: "enforce" as const, network: "open" as const, allowedDirs: [] as string[] };
  const root = process.platform === "win32" ? "C:\\" : "/";
  assert.equal(classifyCommand(`cd ${root} && cat etc/passwd`, workspace, policy).class, "deny");
  assert.equal(classifyCommand(`cd .. && cat ../../Windows/win.ini`, workspace, policy).class, "deny");
  // Building inside the project is not caught by this rule.
  assert.equal(classifyCommand("cd src && npm test", workspace, policy).class, "allow");
});

test("a parent-relative path that leaves the workspace is denied", async () => {
  const { pathsOutsideWorkspace } = await import("../src/sandbox.ts");
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-dotdot-"));
  assert.ok(pathsOutsideWorkspace("cat ../../etc/passwd", workspace, []).length > 0);
});

/* ---------- the query loop ---------- */

async function makeQuery(messages: ChatMessage[], scenario: Parameters<Awaited<typeof import("./fakeServer.ts")>["startFakeServer"]>[0]) {
  const { query } = await import("../src/query.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { ToolPipeline } = await import("../src/tools/pipeline.ts");
  const { startFakeServer } = await import("./fakeServer.ts");
  const fake = await startFakeServer(scenario);
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 8,
    allowedDirs: [],
    autoApprove: [],
  };
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  const pipeline = new ToolPipeline(() => [], {
    config,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: process.cwd(),
    runSubagent: async () => "",
  });
  return { query, client, fake, config, pipeline, messages };
}

test("an empty reply is asked once more before the turn ends", async () => {
  let calls = 0;
  const { query, client, fake, config, pipeline, messages } = await makeQuery([{ role: "user", content: "hi" }], () => {
    calls++;
    return calls === 1 ? {} : { text: "here is the answer" };
  });
  const events = [];
  const result = await (async () => {
    const generator = query({
      messages,
      config,
      client,
      pipeline,
      apiTools: () => [],
      signal: new AbortController().signal,
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })();
  assert.equal(result.reason, "complete");
  assert.equal(calls, 2, "the empty reply was retried once");
  assert.ok(events.some((event) => event.type === "warning" && /empty/.test(event.text)));
  await fake.close();
});

test("a reply cut off at max_tokens is continued instead of abandoned", async () => {
  let calls = 0;
  const { query, client, fake, config, pipeline, messages } = await makeQuery([{ role: "user", content: "write it" }], () => {
    calls++;
    // The fake server always reports "stop"; the length case is injected by
    // wrapping the client below.
    return { text: `part ${calls}` };
  });
  const originalChat = client.chat.bind(client);
  client.chat = async (msgs, tools, onText, onThinking, signal) => {
    const result = await originalChat(msgs, tools, onText, onThinking, signal);
    return calls === 1 ? { ...result, finishReason: "length" } : result;
  };
  const events = [];
  const result = await (async () => {
    const generator = query({
      messages,
      config,
      client,
      pipeline,
      apiTools: () => [],
      signal: new AbortController().signal,
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })();
  assert.equal(result.reason, "complete");
  assert.equal(calls, 2, "a continuation request was sent");
  assert.ok(events.some((event) => event.type === "warning" && /max_tokens/.test(event.text)));
  await fake.close();
});

test("text queued during a final text-only reply is delivered, not stranded", async () => {
  const { query, client, fake, config, pipeline, messages } = await makeQuery([{ role: "user", content: "first" }], (body) => {
    const users = body.messages.filter((message) => message.role === "user");
    return { text: `answered ${users.length}` };
  });
  const queue = ["second request"];
  const generator = query({
    messages,
    config,
    client,
    pipeline,
    apiTools: () => [],
    signal: new AbortController().signal,
    drainQueue: () => (queue.length ? queue.splice(0) : []),
  });
  for await (const _event of generator) {
    /* run to the end */
  }
  // The queued line arrived while the model was composing the final answer, so
  // it is drained at the end of the loop and becomes another turn instead of
  // waiting for the user to type again.
  assert.equal(messages.filter((message) => message.role === "user").length, 2, "the queued message became a turn");
  assert.ok(messages.some((message) => message.role === "user" && message.content === "second request"));
  await fake.close();
});

test("independent reads in one batch run concurrently and keep their order", async () => {
  const { ToolPipeline } = await import("../src/tools/pipeline.ts");
  const { query } = await import("../src/query.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { startFakeServer } = await import("./fakeServer.ts");
  let requested = 0;
  const fake = await startFakeServer((body) => {
    requested++;
    if (requested === 1) {
      return {
        toolCalls: [
          { name: "slow_read", args: JSON.stringify({ id: 1 }) },
          { name: "slow_read", args: JSON.stringify({ id: 2 }) },
          { name: "slow_read", args: JSON.stringify({ id: 3 }) },
        ],
      };
    }
    return { text: "done" };
  });
  let active = 0;
  let peak = 0;
  const tool = {
    name: "slow_read",
    description: "",
    parameters: {},
    readonly: true,
    summarize: () => "",
    async execute(input: Record<string, unknown>) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active--;
      return { content: `read ${input.id}` };
    },
  };
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 6,
    allowedDirs: [],
    autoApprove: [],
  };
  const messages: ChatMessage[] = [{ role: "user", content: "read three" }];
  const pipeline = new ToolPipeline(() => [tool], {
    config,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: process.cwd(),
    runSubagent: async () => "",
  });
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  const generator = query({ messages, config, client, pipeline, apiTools: () => [], signal: new AbortController().signal });
  for await (const _event of generator) {
    /* run the loop */
  }
  assert.ok(peak > 1, `reads overlapped (peak ${peak})`);
  const toolMessages = messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => String(message.content)), ["read 1", "read 2", "read 3"]);
  await fake.close();
});

test("a mutating call is never run alongside another call", async () => {
  const { ToolPipeline } = await import("../src/tools/pipeline.ts");
  const { query } = await import("../src/query.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { startFakeServer } = await import("./fakeServer.ts");
  let requested = 0;
  const fake = await startFakeServer(() => {
    requested++;
    if (requested === 1) {
      return {
        toolCalls: [
          { name: "reader", args: "{}" },
          { name: "writer", args: "{}" },
          { name: "reader", args: "{}" },
        ],
      };
    }
    return { text: "done" };
  });
  const order: string[] = [];
  const reader = {
    name: "reader",
    description: "",
    parameters: {},
    readonly: true,
    summarize: () => "",
    async execute() {
      order.push("reader-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("reader-end");
      return { content: "r" };
    },
  };
  const writer = {
    name: "writer",
    description: "",
    parameters: {},
    readonly: false,
    summarize: () => "",
    async execute() {
      order.push("writer-run");
      return { content: "w" };
    },
  };
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 6,
    allowedDirs: [],
    autoApprove: [],
  };
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  const pipeline = new ToolPipeline(() => [reader, writer], {
    config,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: process.cwd(),
    runSubagent: async () => "",
  });
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  for await (const _event of query({ messages, config, client, pipeline, apiTools: () => [], signal: new AbortController().signal })) {
    /* run */
  }
  // The first read completes before the write starts; the second read runs
  // after the write, never overlapping it.
  assert.deepEqual(order, ["reader-start", "reader-end", "writer-run", "reader-start", "reader-end"]);
  await fake.close();
});

/* ---------- hooks can stop compaction ---------- */

test("PreCompact runs before the rewrite and can block it", async () => {
  const { Agent } = await import("../src/agent.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { startFakeServer } = await import("./fakeServer.ts");
  const fake = await startFakeServer(() => ({ text: "ok" }));
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-precompact-"));
  mkdirSync(join(workspace, ".prometheus"), { recursive: true });
  writeFileSync(
    join(workspace, ".prometheus", "hooks.json"),
    JSON.stringify({ hooks: { PreCompact: [{ command: `${process.execPath} -e "process.exit(1)"` }] } }),
    "utf8",
  );
  const { trustProjectHooks } = await import("../src/hooks.ts");
  trustProjectHooks(workspace);
  const { Permissions } = await import("../src/permissions.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 2000,
    maxTurns: 2,
    allowedDirs: [],
    autoApprove: [],
  };
  const messages: ChatMessage[] = [{ role: "user", content: `big ${"x".repeat(4000)}` }];
  for (let index = 0; index < 20; index++) {
    messages.push({ role: "assistant", content: `a${index} ${"y".repeat(2000)}` });
    messages.push({ role: "user", content: `u${index} ${"z".repeat(2000)}` });
  }
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    const agent = new Agent(config, ui, new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 }), [], new Permissions(config, ui), messages);
    const before = agent.messages.length;
    await assert.rejects(() => agent.compactNow({}), /blocked by a PreCompact hook/);
    assert.equal(agent.messages.length, before, "the transcript was not rewritten");
  } finally {
    process.chdir(previous);
    await fake.close();
  }
});
