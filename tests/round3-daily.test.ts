/**
 * Round-three daily-use fixes: token estimates, truncation, and compaction.
 *
 * These are the numbers and the text a user actually sees. A token estimate
 * that is 4x low lets a request overflow the window; a truncation that drops
 * the tail hides the error that explains a failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, trimToolOutput } from "../src/context.ts";
import type { ChatMessage } from "../src/types.ts";

/* ---------- 4.6 a CJK character is not a quarter of a token ---------- */

test("CJK text is estimated close to one token per character", () => {
  const chinese: ChatMessage[] = [{ role: "user", content: "这是一个中文句子，用来测试分词估算。".repeat(10) }];
  const ascii: ChatMessage[] = [{ role: "user", content: "x".repeat(180) }];
  const zhTokens = estimateTokens(chinese);
  const enTokens = estimateTokens(ascii);
  // 180 CJK characters are roughly 180 tokens; 180 ASCII letters are ~45.
  assert.ok(zhTokens > enTokens * 2.5, `CJK estimate ${zhTokens} should dwarf ASCII ${enTokens}`);
  assert.ok(zhTokens >= 150, `CJK estimate ${zhTokens} is too low for ~180 characters`);
});

test("a mixed line does not lose its ASCII half", () => {
  const mixed: ChatMessage[] = [{ role: "user", content: "运行 npm test 并修复错误".repeat(4) }];
  const tokens = estimateTokens(mixed);
  assert.ok(tokens > 20, `mixed estimate ${tokens}`);
});

/* ---------- 4.4 a failed command's error is at the end, so keep the end ---------- */

test("a truncated tool output keeps the tail, where the failure is", () => {
  const lines = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
  lines.push("error: cannot find symbol");
  const output = lines.join("\n");
  const trimmed = trimToolOutput(output, 2000);
  assert.ok(trimmed.length <= 2200, `kept ${trimmed.length} characters`);
  assert.match(trimmed, /cannot find symbol/, "the tail survives");
  assert.match(trimmed, /trimmed|omitted/i, "the omission is stated");
  assert.doesNotMatch(trimmed, /^line 0$/, "the head was not kept verbatim on its own");
});

test("a short output is returned untouched", () => {
  assert.equal(trimToolOutput("hello\nworld", 2000), "hello\nworld");
});

/* ---------- 4.3 compaction keeps the original goal ---------- */

test("the recap names the first request even after many turns", async () => {
  const { compactWithModel } = await import("../src/context.ts");
  const messages: ChatMessage[] = [{ role: "user", content: "把登录改成 OAuth，并保留旧的 cookie 登录作为回退" }];
  for (let index = 0; index < 40; index++) {
    messages.push({ role: "user", content: `step ${index} ${"x".repeat(3000)}` });
    messages.push({ role: "assistant", content: `ok ${index} ${"y".repeat(3000)}` });
  }
  const result = await compactWithModel(messages, 20_000, { summarize: async (_old, local) => local });
  assert.ok(result, "compaction ran");
  assert.match(result.summary, /OAuth/, "the original goal is still in the recap");
});
