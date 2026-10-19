/**
 * Round four: the foundation fixes the plan lists as A1, E1, E16 and A2.
 *
 * Each test reproduces a defect found while verifying the research reports:
 * a retried request re-printed its opening sentence and a failed one lost the
 * text the user had already read, `--mode auto --dont-ask` still asked a
 * person, a fallback that answered was billed to the primary model, and the
 * spilled tool output named a path no tool could read back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonUi } from "../src/headless.ts";
import { Permissions, isInsideToolResults, resolveReadablePath } from "../src/permissions.ts";
import { FallbackChatClient } from "../src/fallback.ts";
import { ApiError } from "../src/llm.ts";
import type { ChatMessage, Config } from "../src/types.ts";
import { query, type QueryEvent } from "../src/query.ts";
import { ToolPipeline } from "../src/tools/pipeline.ts";

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "fake-model",
    maxTokens: 1000,
    permissionMode: "auto",
    thinkingEffort: "auto",
    contextWindow: 128000,
    maxTurns: 6,
    allowedDirs: [],
    autoApprove: [],
    ...overrides,
  };
}

/** A client that streams `text`, then fails (or succeeds) as told. */
function streamingClient(script: { text: string; fail?: boolean }[]) {
  let call = 0;
  return {
    options: { model: "primary", baseUrl: "", apiKey: "" },
    calls: () => call,
    async chat(
      _messages: unknown,
      _tools: unknown,
      onText: (delta: string) => void,
    ) {
      const step = script[Math.min(call, script.length - 1)];
      call++;
      for (const chunk of step.text.match(/[\s\S]{1,5}/g) ?? []) onText(chunk);
      if (step.fail) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return {
        content: step.text,
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      };
    },
  };
}

async function collect(events: AsyncGenerator<QueryEvent>): Promise<QueryEvent[]> {
  const seen: QueryEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/* ---------- A1: a failed stream keeps what the user already read ---------- */

test("text streamed before a terminal failure is kept in the transcript", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "explain the build" }];
  // terminal classification (no retry) is what used to discard the partial
  const client = streamingClient([{ text: "PARTIAL ANSWER ", fail: true }]);
  const cfg = config();
  const ui = new JsonUi();
  const pipeline = new ToolPipeline(() => [], {
    config: cfg,
    ui,
    permissions: new Permissions(cfg, ui),
    todos: { items: [] },
    hooks: [],
    cwd: process.cwd(),
  });
  const events = await collect(
    query({
      messages,
      config: cfg,
      client: client as never,
      pipeline,
      apiTools: () => [],
      signal: new AbortController().signal,
      maxRetries: 1,
    }),
  );
  assert.ok(events.some((event) => event.type === "error"), "the turn still reports the failure");
  const last = messages[messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.match(String(last.content), /PARTIAL ANSWER/, "the reader's copy and the transcript agree");
});

test("a retried request tells the UI to drop the first attempt", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const client = streamingClient([
    { text: "FIRST HALF ", fail: true },
    { text: "COMPLETE ANSWER" },
  ]);
  const cfg = config();
  const ui = new JsonUi();
  const pipeline = new ToolPipeline(() => [], {
    config: cfg,
    ui,
    permissions: new Permissions(cfg, ui),
    todos: { items: [] },
    hooks: [],
    cwd: process.cwd(),
  });
  const events = await collect(
    query({
      messages,
      config: cfg,
      client: client as never,
      pipeline,
      apiTools: () => [],
      signal: new AbortController().signal,
      maxRetries: 2,
    }),
  );
  const discard = events.findIndex((event) => event.type === "assistant_discard");
  const retry = events.findIndex((event) => event.type === "retry");
  assert.ok(retry >= 0, "the connection reset is retried");
  assert.ok(discard > retry, "the discard follows the retry notice and precedes the new stream");
  const answer = messages.filter((message) => message.role === "assistant").pop();
  assert.equal(answer?.content, "COMPLETE ANSWER", "only the answering attempt is kept");
});

/* ---------- E1: --mode auto --dont-ask can approve a sandboxed command ---------- */

test("an unattended auto run executes a command the sandbox would ask about", async () => {
  const ui = new JsonUi();
  const cfg = config({ permissionMode: "auto", unattended: true, autoApprove: ["*"] });
  const permissions = new Permissions(cfg, ui);
  const { bashTool } = await import("../src/tools/shellTools.ts");
  // `npm install` classifies as confirm because it reaches the network.
  const verdict = await permissions.check(bashTool, { command: "npm install" });
  assert.equal(verdict.allowed, true, "the standing grant answers before the prompt would be shown");
});

test("without a standing grant the auto run still asks, and refuses with no one to ask", async () => {
  const ui = new JsonUi();
  const cfg = config({ permissionMode: "auto", unattended: true, autoApprove: [] });
  const permissions = new Permissions(cfg, ui);
  const { bashTool } = await import("../src/tools/shellTools.ts");
  const verdict = await permissions.check(bashTool, { command: "npm install" });
  assert.equal(verdict.allowed, false);
});

/* ---------- E16: a fallback that answered is the model that gets billed ---------- */

test("the active client names the fallback that actually answered", async () => {
  const primary = {
    options: { model: "primary-model" },
    async chat() {
      throw new ApiError(404, "model not found");
    },
  };
  const secondary = {
    options: { model: "fallback-model" },
    async chat() {
      return { content: "ok", reasoning: "", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    },
  };
  const client = new FallbackChatClient({
    primary: primary as never,
    fallbacks: () => [secondary as never],
  });
  let notified: string[] = [];
  const withCallback = new FallbackChatClient({
    primary: primary as never,
    fallbacks: () => [secondary as never],
    onFallback: (from, to) => notified.push(`${from}->${to}`),
  });
  await client.chat([], [], () => {}, () => {}, new AbortController().signal);
  await withCallback.chat([], [], () => {}, () => {}, new AbortController().signal);
  assert.equal(client.active.options?.model, "fallback-model", "usage is attributed to the model that ran");
  assert.deepEqual(notified, ["primary-model->fallback-model"]);
});

/* ---------- A2: spilled output can be read back ---------- */

test("a spilled tool result is readable through the read-only allowance", async () => {
  const { SESSIONS_DIR } = await import("../src/config.ts");
  const sessionId = `round4-${process.pid}-${Date.now()}`;
  const dir = join(SESSIONS_DIR, sessionId, "tool-results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "out.txt");
  writeFileSync(file, "the full compiler error", "utf8");
  try {
    assert.equal(isInsideToolResults(file), true);
    const readable = resolveReadablePath(file, process.cwd(), []);
    assert.equal(readable, file, "the pointer in the tool message is not a dead end");
    // A sibling under the session directory is still not readable.
    const secret = join(SESSIONS_DIR, sessionId, "meta.json");
    writeFileSync(secret, "{}", "utf8");
    assert.throws(() => resolveReadablePath(secret, process.cwd(), []), /escapes the workspace/);
  } finally {
    rmSync(join(SESSIONS_DIR, sessionId), { recursive: true, force: true });
  }
});

test("writing to the spill directory is still refused", async () => {
  const { resolveSafePath } = await import("../src/permissions.ts");
  const { SESSIONS_DIR } = await import("../src/config.ts");
  const target = join(SESSIONS_DIR, "someone-else", "tool-results", "x.txt");
  assert.throws(() => resolveSafePath(target, process.cwd(), []), /escapes the workspace/);
});
