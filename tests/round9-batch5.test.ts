/**
 * Round 9, batch 5: the review loop and sub-agents.
 *
 * U13 undo one file from the diff pane, U14 rewind by turn from History,
 * U15 rewind on the turn just sent, U16 the literal `\n` in `@` references,
 * U17 bash edits join the rewind, U18 the diff signature used a field that does
 * not exist, U19 inline diff cards pair by call id, U20/U21 sub-agent cards key
 * on id instead of one slot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changeSignature } from "../desktop/renderer/changeSignature.js";
import { withMentionedFiles } from "../desktop/mentions.js";
import { SubagentCards } from "../desktop/renderer/subagentCards.js";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const host = readFileSync("desktop/host.js", "utf8");
const agent = readFileSync("src/agent.ts", "utf8");
const types = readFileSync("src/types.ts", "utf8");
const shell = readFileSync("src/tools/shellTools.ts", "utf8");

/* ---------- U13: undo one file ---------- */

test("every changed file offers undo beside it", () => {
  const start = app.indexOf("function renderDiffFileList");
  const body = app.slice(start, start + 2200);
  assert.match(body, /data-undo|undo-file|restoreFile/, "the row can undo this one file");
  assert.match(app, /cmd: "restoreFile"/, "the host command is used");
});

/* ---------- U14: rewind by turn ---------- */

test("a turn header in History offers a rewind to that turn", () => {
  const start = app.indexOf("function renderCheckpoints");
  const body = app.slice(start, app.indexOf("function renderTree", start));
  assert.match(body, /checkpoint-turn/);
  assert.match(body, /checkpoint-rewind/);
  assert.match(body, /cmd: "rewindTo"/);
});

test("the header action is left off for the first turn", () => {
  // Rewinding to the first message is "undo everything"; the History list's
  // existing restore button already does that, so the header does not duplicate
  // it for turn 1.
  const start = app.indexOf("function renderCheckpoints");
  const body = app.slice(start, app.indexOf("function renderTree", start));
  assert.match(body, /messageIndex > 1/, "turn 1 is left to the existing restore button");
});

/* ---------- U15: rewind on the turn just sent ---------- */

test("a sent turn is given a rewind as soon as the host accepts it", () => {
  assert.match(host, /type: "prompt_accepted"/, "the host reports where the message landed");
  assert.match(app, /case "prompt_accepted"/, "the renderer listens for it");
  assert.match(app, /case "prompt_accepted"[\s\S]{0,400}attachRewind/, "and attaches the rewind there");
});

test("the accepted index is where the user message landed", () => {
  assert.match(host, /prompt_accepted[\s\S]{0,200}index/);
});

/* ---------- U16: the literal backslash-n ---------- */

test("a referenced file is separated by real newlines", () => {
  const result = withMentionedFiles("what does this do?", [{ path: "notes.md", content: "hello" }]);
  assert.equal(result, '<file path="notes.md">hello</file>\n\nwhat does this do?');
  // The bug was literal backslashes in the prompt; assert on the bytes.
  assert.ok(!result.includes("\\n"), "no literal backslash-n in the prompt");
});

test("several referenced files are each on their own block", () => {
  const result = withMentionedFiles("go", [
    { path: "a.md", content: "A" },
    { path: "b.md", content: "B" },
  ]);
  assert.equal(result, '<file path="a.md">A</file>\n\n<file path="b.md">B</file>\n\ngo');
});

test("a file too large to inline says so instead of being pasted", () => {
  const result = withMentionedFiles("go", [{ path: "big.bin", content: "", bytes: 999999, tooLarge: true }]);
  assert.match(result, /too large to inline/);
  assert.match(result, /big\.bin/);
});

/* ---------- U17: bash edits join the rewind ---------- */

test("the tool context carries the message index", () => {
  assert.match(types, /messageIndex\?: number/);
});

test("bash change capture passes it through", () => {
  assert.match(shell, /messageIndex/);
});

/* ---------- U18: the diff signature ---------- */

test("the signature changes when the hunks change but the counts do not", () => {
  const before = changeSignature({
    files: [{ path: "a.ts", additions: 1, deletions: 1, hunks: [{ header: "@@ -1,3 +1,3 @@", lines: ["-one", "+two"] }] }],
    selected: "a.ts",
    scope: "turn",
  });
  const after = changeSignature({
    files: [{ path: "a.ts", additions: 1, deletions: 1, hunks: [{ header: "@@ -1,3 +1,3 @@", lines: ["-uno", "+dos"] }] }],
    selected: "a.ts",
    scope: "turn",
  });
  assert.notEqual(before, after);
});

test("an identical payload keeps its signature", () => {
  const file = { path: "a.ts", additions: 1, deletions: 1, hunks: [{ header: "@@", lines: ["-one", "+two"] }] };
  const a = changeSignature({ files: [file], selected: "a.ts", scope: "turn" });
  const b = changeSignature({ files: [{ ...file }], selected: "a.ts", scope: "turn" });
  assert.equal(a, b);
});

test("the renderer no longer reads a diff field the host never sends", () => {
  assert.ok(!/file\.diff\?\.length/.test(app), "ChangeSummary has hunks, not diff");
});

/* ---------- U19: inline diff cards pair by call id ---------- */

test("the inline diff finds its row by call id, not by the last row touched", () => {
  const detail = app.indexOf('case "tool_detail"');
  const body = app.slice(detail, app.indexOf('case "tool_end"', detail));
  assert.match(body, /data-call-id/);
  assert.ok(!/const row = state\.lastToolNode;/.test(body), "the single-slot fallback is not the rule");
});

test("tool_start stamps the call id on the row", () => {
  const start = app.indexOf('case "tool_start"');
  const body = app.slice(start, app.indexOf('case "tool_detail"', start));
  assert.match(body, /addToolRow\(message\.name, message\.summary, message\.id/);
  assert.match(app, /row\.dataset\.callId = callId/);
});

/* ---------- U20/U21: sub-agent cards key on id ---------- */

test("each start creates a card keyed by its id, and all three paths have one", () => {
  const cards = new SubagentCards();
  cards.start("id-a", "first");
  cards.start("id-b", "second");
  assert.equal(cards.get("id-a").status, "running");
  assert.equal(cards.get("id-b").prompt, "second");
});

test("an end for one card leaves the other running", () => {
  const cards = new SubagentCards();
  cards.start("id-a", "first");
  cards.start("id-b", "second");
  cards.end("id-a", true);
  assert.equal(cards.get("id-a").status, "done");
  assert.equal(cards.get("id-b").status, "running");
});

test("an activity lands on the card it names", () => {
  const cards = new SubagentCards();
  cards.start("id-a", "first");
  cards.start("id-b", "second");
  cards.activity("id-b", "tool", "id-b: read_file");
  assert.equal(cards.get("id-b").count, 1);
  assert.equal(cards.get("id-a").count, 0);
});

test("an activity with no id falls back to the newest running card", () => {
  const cards = new SubagentCards();
  cards.start("id-a", "first");
  cards.activity("", "tool", "anonymous");
  assert.equal(cards.get("id-a").count, 1);
});

test("the parallel and background paths send an id", () => {
  const parallel = agent.slice(agent.indexOf("private async runSubagents"), agent.indexOf("private startBackgroundSubagent"));
  // Every start in this branch passes `{ id: record.id }`, not just the
  // interactive path; two cards without ids collapse into one slot.
  assert.ok(parallel.includes("{ id: record.id }"), "parallel starts carry the record id");
  const background = agent.slice(agent.indexOf("private startBackgroundSubagent"));
  assert.ok(background.slice(0, 1400).includes("{ id: record.id }"), "a background start carries its record id");
  assert.equal((agent.match(/subagentStart\?\.\([^;]*\);/g) ?? []).filter((call) => !/\{\s*id[:\s}]/.test(call)).length, 0, "no start is left without an id");
});

test("the end event carries the id too", () => {
  assert.ok(types.includes("subagentEnd?(ok: boolean, summary: string, meta?: { id: string }): void;"));
  assert.ok(types.includes("subagentStart?(prompt: string, meta?: { id: string }): void;"));
});
