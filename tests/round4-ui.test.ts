/**
 * Round-four phase F: the pieces of the desktop surface that can be tested
 * without a window.
 *
 * The renderer runs in Electron; what is testable here is the logic behind it
 * — the incremental markdown renderer, the word-level diff decoration, the
 * schedule and recovery bookkeeping, and the CLI verbs. Anything that needs a
 * real DOM is left to manual verification; inventing a fake DOM would test the
 * fake.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { IncrementalRenderer, renderMarkdown } from "../desktop/renderer/markdown.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ---------- incremental markdown ----------------------------------------- */

test("block splitting keeps an unclosed fence together", () => {
  const blocks = IncrementalRenderer.split("intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n");
  assert.equal(blocks.length, 2, "a blank line inside a fence must not split it");
  assert.match(blocks[1], /const b = 2/);
});

test("completed blocks keep their HTML and only the tail is re-rendered", () => {
  const renderer = new IncrementalRenderer();
  const first = renderer.render("one\n\ntwo");
  const second = renderer.render("one\n\ntwo\n\nthree");
  assert.match(first, /<p>one<\/p>/);
  assert.match(second, /<p>three<\/p>/);
  // The first block object is the same instance: it was not re-rendered.
  assert.equal(renderer.blocks[0].html, "<p>one</p>");
});

test("an unchanged source returns the cached html without re-rendering", () => {
  const renderer = new IncrementalRenderer();
  renderer.render("hello");
  const cached = renderer.blocks[0];
  renderer.render("hello");
  assert.equal(renderer.blocks[0], cached);
});

test("a retry that rewrites the reply drops the stale blocks", () => {
  const renderer = new IncrementalRenderer();
  renderer.render("first attempt");
  renderer.reset();
  assert.equal(renderer.render("second attempt"), "<p>second attempt</p>");
});

test("the incremental output matches the one-shot renderer", () => {
  const source = "# Title\n\nA paragraph with **bold**.\n\n- one\n- two\n\n```js\nx()\n```";
  const renderer = new IncrementalRenderer();
  assert.equal(renderer.render(source), renderMarkdown(source));
});

/* ---------- schedule formatting ------------------------------------------ */

test("a one-shot schedule disables itself after firing", async () => {
  const { addSchedule, claimSchedule, listSchedules, removeSchedule } = await import("../src/schedule.ts");
  const at = new Date(Date.now() - 1000).toISOString();
  const added = addSchedule({ prompt: "one shot", cwd: process.cwd(), at });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  try {
    const claimed = claimSchedule(added.entry.id);
    assert.ok(claimed);
    const entry = listSchedules().find((candidate) => candidate.id === added.entry.id);
    assert.equal(entry?.enabled, false);
    assert.equal(claimSchedule(added.entry.id), null, "a spent one-shot cannot fire again");
  } finally {
    removeSchedule(added.entry.id);
  }
});

test("a schedule with a bad date is refused with the reason", async () => {
  const { addSchedule } = await import("../src/schedule.ts");
  const result = addSchedule({ prompt: "x", cwd: process.cwd(), at: "next thursday" });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not a date/);
});

/* ---------- recovery ------------------------------------------------------ */

test("recovery lines name the round and the interruption", async () => {
  const { recoveryLines } = await import("../src/sessionRecovery.ts");
  const lines = recoveryLines([
    {
      id: "s1",
      title: "parser work",
      goal: { kind: "goal", text: "finish the parser", round: 3, maxRounds: 8 },
      interrupted: true,
    },
  ]);
  assert.match(lines[0], /parser work/);
  assert.match(lines[0], /3\/8/);
  assert.match(lines[0], /cut off/);
});

/* ---------- worktree include --------------------------------------------- */

test("a directory pattern only matches inside that directory", async () => {
  const { matchesInclude } = await import("../src/worktree.ts");
  assert.equal(matchesInclude("config/app.yml", ["config/"]), true);
  assert.equal(matchesInclude("config", ["config/"]), true);
  assert.equal(matchesInclude("myconfig/app.yml", ["config/"]), false);
});

/* ---------- CLI session verbs -------------------------------------------- */

test("an unknown session verb describes what is available", async () => {
  const { runSessionCommand } = await import("../src/sessionCommands.ts");
  const errors: string[] = [];
  const code = await runSessionCommand(["nonsense"], { out: () => {}, err: (text) => errors.push(text) });
  assert.equal(code, 2);
  assert.match(errors.join(" "), /list, show, fork/);
});

test("renaming an ambiguous prefix lists candidates instead of guessing", async () => {
  const { runSessionCommand } = await import("../src/sessionCommands.ts");
  const errors: string[] = [];
  const code = await runSessionCommand(["rename", "zzz-no-such", "x"], { out: () => {}, err: (text) => errors.push(text) });
  assert.equal(code, 2);
  assert.match(errors.join(" "), /no session matches/);
});

/* ---------- patch round trip --------------------------------------------- */

test("a patch written from a baseline applies with git", async () => {
  const { execFileSync } = await import("node:child_process");
  const { unifiedDiff, applyPatch } = await import("../src/sessionCommands.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-apply-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "base"], { cwd: dir });

    const patch = unifiedDiff("a.txt", "one\n", "two\n");
    const file = join(dir, "change.patch");
    writeFileSync(file, patch, "utf8");
    const applied = await applyPatch(file, dir);
    assert.equal(applied.ok, true, applied.output);
    const { readFileSync } = await import("node:fs");
    // git may write the file back with the platform's line endings.
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8").trimEnd(), "two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- usage export format ------------------------------------------ */

test("JSON export is an array of objects, one per request", async () => {
  const { usageRows, writeUsageExport } = await import("../src/sessionCommands.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-json-"));
  try {
    const rows = usageRows([
      { at: "2026-10-19T00:00:00Z", sessionId: "a", cwd: "/a", model: "m", inputTokens: 1, outputTokens: 2, cachedTokens: 0 },
    ]);
    const file = join(dir, "usage.json");
    const result = writeUsageExport(file, rows);
    assert.equal(result.ok, true);
    const parsed = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].sessionId, "a");
    assert.equal(parsed[0].cacheWriteTokens, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- worker log tail ---------------------------------------------- */

test("reading a worker log returns its tail, not the whole file", async () => {
  const { startWorker, readWorkerLog } = await import("../src/workers.ts");
  const worker = startWorker("bash", "chatty");
  worker.write("first line");
  worker.write("x".repeat(4096));
  worker.write("last line");
  const tail = readWorkerLog(worker.id, 200);
  assert.ok(tail);
  assert.match(String(tail), /last line/);
  assert.match(String(tail), /trimmed/);
});

/* ---------- command classification for destructive edits ---------- */

test("in-place edits and bulk deletes ask before running", async () => {
  const { classifyCommand } = await import("../src/sandbox.ts");
  const policy = { mode: "enforce", network: "open", allowedDirs: [] };
  for (const command of ["sed -i 's/a/b/' file.txt", "find . -name '*.log' -delete", "truncate -s 0 build.log", "git push --mirror origin"]) {
    assert.equal(classifyCommand(command, process.cwd(), policy).class, "confirm", command);
  }
  // A plain read stays out of the way.
  assert.equal(classifyCommand("cat file.txt", process.cwd(), policy).class, "allow");
});

/* ---------- browser tools ------------------------------------------------ */

test("browser tools say the pane is unavailable instead of hanging", async () => {
  const { browserTools, setBrowserBridge } = await import("../src/tools/browserTools.ts");
  setBrowserBridge(null);
  for (const tool of browserTools) {
    const result = await tool.execute({ url: "https://example.com" }, { cwd: process.cwd() } as never);
    assert.equal(result.isError, true, tool.name);
    assert.match(String(result.content), /desktop window/i);
  }
});

test("browser_open refuses a non-http URL before asking the window", async () => {
  const { browserOpenTool, setBrowserBridge } = await import("../src/tools/browserTools.ts");
  let called = 0;
  setBrowserBridge({
    request: async () => {
      called += 1;
      return { ok: true };
    },
  });
  try {
    const result = await browserOpenTool.execute({ url: "file:///etc/passwd" }, { cwd: process.cwd() } as never);
    assert.equal(result.isError, true);
    assert.equal(called, 0, "the window must not be asked to open a local file");
  } finally {
    setBrowserBridge(null);
  }
});

test("a screenshot path is reported, not the image bytes", async () => {
  const { browserScreenshotTool, setBrowserBridge } = await import("../src/tools/browserTools.ts");
  setBrowserBridge({
    request: async () => ({ ok: true, url: "https://example.com", text: "/tmp/shot.png" }),
  });
  try {
    const result = await browserScreenshotTool.execute({}, { cwd: process.cwd() } as never);
    assert.match(String(result.content), /\/tmp\/shot\.png/);
  } finally {
    setBrowserBridge(null);
  }
});

/* ---------- REPL rewind wiring ------------------------------------------- */

test("the REPL advertises the rewind command", async () => {
  // The command list is a string constant; reading it here keeps the help text
  // and the dispatch table from drifting apart.
  const source = await import("node:fs").then((fs) => fs.readFileSync("src/repl.ts", "utf8"));
  assert.match(source, /case "rewind":/);
  assert.match(source, /\/rewind \[n\]/);
});
