/** Session markdown export and interrupted-run markers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sessionToMarkdown, exportFilename, markRunActive, clearRunActive, findInterruptedRun } from "../src/export.ts";

const session = {
  id: "20260101-0000-abcd",
  cwd: "C:/work/project",
  model: "glm-5.3-flash",
  baseUrl: "http://localhost/v1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  messages: [
    { role: "system", content: "system prompt" },
    { role: "user", content: "read a.ts" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    },
    { role: "tool", tool_call_id: "1", content: "line one\nline two" },
    { role: "assistant", content: "It exports a value." },
  ],
};

test("markdown export keeps the conversation and folds tool calls", () => {
  const md = sessionToMarkdown(session as never);
  assert.match(md, /^# Prometheus session 20260101-0000-abcd/);
  assert.match(md, /## You\n\nread a\.ts/);
  assert.match(md, /## Prometheus\n\nIt exports a value\./);
  assert.match(md, /`read_file` a\.ts/);
  assert.match(md, /↳ line one line two/);
  assert.doesNotMatch(md, /system prompt/);
});

test("export filenames are filesystem-safe", () => {
  assert.equal(exportFilename(session as never), "prometheus-2026-01-01-00-00-00.md");
});

test("an interrupted run is detected once, then cleared", () => {
  const cwd = `C:/tmp/export-test-${Date.now()}`;
  markRunActive({ sessionId: "abc", cwd, startedAt: new Date().toISOString() });
  const found = findInterruptedRun(cwd);
  assert.equal(found?.sessionId, "abc");
  assert.equal(findInterruptedRun(cwd), null, "the marker is consumed");
  clearRunActive();
  assert.equal(existsSync(`${process.env.USERPROFILE}/.prometheus/active-run.json`), false);
});
