/** Unit tests for compaction, glob conversion, and streaming parsing. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, compact, compactForce } from "../src/context.ts";
import { globToRegExp } from "../src/tools/fsUtil.ts";
import { ChatClient } from "../src/llm.ts";
import { startFakeServer } from "./fakeServer.ts";
import type { ChatMessage } from "../src/llm.ts";

test("compaction keeps the system prompt and recent turns, and summarizes old ones", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `request number ${i} ${"x".repeat(200)}` });
    messages.push({ role: "assistant", content: `answer ${i} ${"y".repeat(200)}` });
  }
  const compacted = compactForce(messages);
  assert.equal(compacted[0].role, "system");
  assert.ok(compacted.length < messages.length);
  const recap = compacted[1];
  assert.equal(recap.role, "user");
  assert.match(String(recap.content), /compacted/);
  assert.ok(estimateTokens(compacted) < estimateTokens(messages));
});

test("compaction is a no-op under budget", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  assert.equal(compact(messages, 128000), null);
});

test("glob conversion handles ** and braces", () => {
  assert.ok(globToRegExp("**/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/*.ts").test("a.ts"));
  assert.ok(!globToRegExp("**/*.ts").test("a.js"));
  assert.ok(globToRegExp("src/**/*.{js,ts}").test("src/x/y.ts"));
  assert.ok(globToRegExp("src/*.js").test("src/a.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/sub/a.js"));
});

test("streaming accumulates split tool-call deltas and usage", async () => {
  const fake = await startFakeServer((body) => {
    if (!body.messages.some((m) => m.role === "tool")) {
      return {
        text: "let me look",
        toolCalls: [{ name: "list_files", args: JSON.stringify({ path: "." }) }],
      };
    }
    return { text: "finished" };
  });
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 1000 });
  const chunks: string[] = [];
  const result = await client.chat(
    [{ role: "user", content: "go" }],
    [{ type: "function", function: { name: "list_files", description: "", parameters: {} } }],
    (d) => chunks.push(d),
    () => {},
    new AbortController().signal,
  );
  assert.equal(result.content, "let me look");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, "list_files");
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { path: "." });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.inputTokens, 100);
  assert.ok(chunks.length > 1, "text arrives in multiple deltas");

  const second = await client.chat(
    [{ role: "user", content: "go" }, { role: "tool", tool_call_id: "x", content: "ok" }],
    [],
    () => {},
    () => {},
    new AbortController().signal,
  );
  assert.equal(second.content, "finished");
  await fake.close();
});
