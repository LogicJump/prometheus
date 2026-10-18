/** The query generator, error classification, and the five-stage tool pipeline. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeServer } from "./fakeServer.ts";
import { classifyError } from "../src/errors.ts";
import { ApiError } from "../src/llm.ts";
import { ToolPipeline } from "../src/tools/pipeline.ts";
import type { Tool } from "../src/types.ts";

/* ---------- error classification ---------- */

test("rate limits and 5xx are recoverable; auth and bad requests are terminal", () => {
  assert.equal(classifyError(new ApiError(429, "slow down")).level, "recoverable");
  assert.equal(classifyError(new ApiError(503, "unavailable")).level, "recoverable");
  assert.equal(classifyError(new ApiError(401, "bad key")).level, "terminal");
  assert.equal(classifyError(new ApiError(400, "bad body")).level, "terminal");
  assert.equal(classifyError(Object.assign(new Error("reset"), { code: "ECONNRESET" })).level, "recoverable");
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).level, "terminal");
});

test("backoff grows with the attempt and is capped", () => {
  const first = classifyError(new ApiError(500, "x"), 1).retryAfterMs;
  const third = classifyError(new ApiError(500, "x"), 3).retryAfterMs;
  assert.equal(first, 800);
  assert.equal(third, 3200);
  assert.ok(classifyError(new ApiError(500, "x"), 20).retryAfterMs <= 15_000);
});

/* ---------- query generator ---------- */

test("the query generator streams a plain answer and ends complete", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-query-"));
  const { query } = await import("../src/query.ts");
  const { startFakeServer: start } = await import("./fakeServer.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const fake = await start(() => ({ text: "hello there" }));
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 4,
    allowedDirs: [],
    autoApprove: [],
  };
  const pipeline = new ToolPipeline(() => [], {
    config,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: workspace,
    runSubagent: async () => "",
  });
  const messages = [{ role: "user" as const, content: "go" }];
  const events: string[] = [];
  let text = "";
  const iterator = query({ messages, config, client, pipeline, apiTools: () => [], signal: new AbortController().signal });
  let finalReason = "";
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      finalReason = next.value.reason;
      break;
    }
    events.push(next.value.type);
    if (next.value.type === "assistant_text") text += next.value.text;
  }
  assert.equal(finalReason, "complete");
  assert.equal(text, "hello there");
  assert.deepEqual(events.filter((type) => type !== "assistant_text"), ["assistant_start", "assistant_end", "usage"]);
  assert.equal(messages[messages.length - 1].role, "assistant");
  await fake.close();
});

test("a tool call runs through the pipeline and its result reaches the model", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-query-tool-"));
  const { query } = await import("../src/query.ts");
  const { startFakeServer: start } = await import("./fakeServer.ts");
  const { ChatClient } = await import("../src/llm.ts");
  let sawToolResult = false;
  const fake = await start((body) => {
    if (body.messages.some((message) => message.role === "tool")) {
      sawToolResult = true;
      return { text: "wrote it" };
    }
    return { toolCalls: [{ name: "write_file", args: JSON.stringify({ path: "a.txt", content: "hi" }) }] };
  });
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 4,
    allowedDirs: [],
    autoApprove: [],
  };
  const { writeFileTool } = await import("../src/tools/fileTools.ts");
  const pipeline = new ToolPipeline(() => [writeFileTool], {
    config,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: workspace,
    runSubagent: async () => "",
  });
  const messages = [{ role: "user" as const, content: "write" }];
  const iterator = query({ messages, config, client, pipeline, apiTools: () => [], signal: new AbortController().signal });
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
  }
  assert.ok(existsSync(join(workspace, "a.txt")));
  assert.ok(sawToolResult, "the model saw the tool result");
  await fake.close();
});

test("queued text is delivered at the tool boundary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-query-queue-"));
  const { query } = await import("../src/query.ts");
  const { startFakeServer: start } = await import("./fakeServer.ts");
  const { ChatClient } = await import("../src/llm.ts");
  let seenQueued = false;
  const fake = await start((body) => {
    if (JSON.stringify(body.messages).includes("extra instruction")) seenQueued = true;
    if (body.messages.some((message) => message.role === "tool")) return { text: "done" };
    return { toolCalls: [{ name: "write_file", args: JSON.stringify({ path: "b.txt", content: "x" }) }] };
  });
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 4,
    allowedDirs: [],
    autoApprove: [],
  };
  const { writeFileTool } = await import("../src/tools/fileTools.ts");
  const queue = ["extra instruction"];
  const pipeline = new ToolPipeline(() => [writeFileTool], {
    config,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: workspace,
    runSubagent: async () => "",
  });
  const messages = [{ role: "user" as const, content: "write" }];
  const iterator = query({
    messages,
    config,
    client,
    pipeline,
    apiTools: () => [],
    signal: new AbortController().signal,
    drainQueue: () => queue.splice(0),
  });
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
  }
  assert.ok(seenQueued, "the queued message joined before the next request");
  assert.ok(messages.some((message) => message.content === "extra instruction"));
  await fake.close();
});

/* ---------- pipeline stages ---------- */

test("the pipeline blocks a tool when a PreToolUse hook exits non-zero", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-pipeline-"));
  const { writeFileTool } = await import("../src/tools/fileTools.ts");
  const command = process.platform === "win32" ? "echo blocked & exit 3" : "echo blocked; exit 3";
  const outcome = await new ToolPipeline(() => [writeFileTool], {
    config: { allowedDirs: [] } as never,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [{ event: "PreToolUse", command }],
    sessionId: "",
    cwd: workspace,
    runSubagent: async () => "",
  }).run("write_file", JSON.stringify({ path: "c.txt", content: "x" }), new AbortController().signal);
  assert.equal(outcome.ok, false);
  assert.match(outcome.content, /blocked/);
  assert.ok(!existsSync(join(workspace, "c.txt")), "the hook prevented the write");
});

test("the pipeline reports malformed arguments and unknown tools without throwing", async () => {
  const pipeline = new ToolPipeline(() => [], {
    config: { allowedDirs: [] } as never,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: tmpdir(),
    runSubagent: async () => "",
  });
  const unknown = await pipeline.run("nope", "{}", new AbortController().signal);
  assert.match(unknown.content, /unknown tool/);
  const tool: Tool = {
    name: "t",
    description: "",
    parameters: {},
    readonly: true,
    summarize: () => "",
    execute: async () => ({ content: "never" }),
  };
  const bad = await new ToolPipeline(() => [tool], {
    config: { allowedDirs: [] } as never,
    ui: {} as never,
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: tmpdir(),
    runSubagent: async () => "",
  }).run("t", "{not json", new AbortController().signal);
  assert.match(bad.content, /not valid JSON/);
});

test("a denied permission returns control to the model as an error", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-pipeline-deny-"));
  const { writeFileTool } = await import("../src/tools/fileTools.ts");
  const outcome = await new ToolPipeline(() => [writeFileTool], {
    config: { allowedDirs: [] } as never,
    ui: {} as never,
    permissions: { mode: "ask", check: async () => ({ allowed: false, reason: "user said no" }) },
    todos: { items: [] },
    hooks: [],
    sessionId: "",
    cwd: workspace,
    runSubagent: async () => "",
  }).run("write_file", JSON.stringify({ path: "d.txt", content: "x" }), new AbortController().signal);
  assert.match(outcome.content, /user said no/);
  assert.ok(!existsSync(join(workspace, "d.txt")));
  writeFileSync(join(workspace, "unused.txt"), "", "utf8");
});

