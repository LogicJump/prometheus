/**
 * Round-four phase F: the pieces of the desktop surface that can be tested
 * without a window.
 *
 * The renderer runs in Electron; what is testable here is the logic behind it
 * — the incremental markdown renderer, the schedule and recovery bookkeeping,
 * and the CLI verbs. Anything that needs a real DOM is left to manual
 * verification; inventing a fake DOM would test the fake.
 *
 * Word-level diff decoration is not covered here: it lives in `app.js`, which
 * reads `document` at module load. The structural side of it (which hunks exist
 * and what `highlights` contains) is asserted in `round9-batch8.test.ts` via
 * the signature helper instead.
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

/* ---------- streaming responsiveness ------------------------------------ */

test("an open code fence is not re-rendered for every token", async () => {
  const { IncrementalRenderer, renderMarkdown } = await import("../desktop/renderer/markdown.js");
  const renderer = new IncrementalRenderer();
  const start = "intro\n\n```ts\nconst a = 1;\n";
  renderer.render(start);
  // A few characters is below the re-render budget, so the cached HTML is
  // returned unchanged rather than re-highlighting the whole block.
  const throttled = renderer.render(start + "x");
  assert.equal(throttled, renderMarkdown(start));
  // Enough growth and the new text appears.
  const grown = renderer.render(start + "x".repeat(400));
  assert.match(grown, /x{10}/);
  // A closed fence renders immediately, so the final state is always correct.
  const closed = renderer.render(start + "x".repeat(5) + "\n```");
  assert.match(closed, /<\/code>/);
});

test("an unchanged source is returned from the cache without a rebuild", async () => {
  const { IncrementalRenderer } = await import("../desktop/renderer/markdown.js");
  const renderer = new IncrementalRenderer();
  const first = renderer.render("# Title\n\nbody");
  const cached = renderer.blocks[0];
  const second = renderer.render("# Title\n\nbody");
  assert.equal(second, first);
  assert.equal(renderer.blocks[0], cached);
});

/* ---------- sidebar resize ---------- */

test("the sidebar resize handle exists and is keyboard reachable", async () => {
  // The renderer has no DOM under node --test, so the contract is asserted on
  // the markup: a separator with a tab stop, and the script that wires it.
  const html = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/index.html", "utf8"));
  assert.match(html, /id="sidebar-resizer"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /tabindex="0"/);
  const app = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/app.js", "utf8"));
  assert.match(app, /prometheus\.sidebarWidth/);
  assert.match(app, /SIDEBAR_MIN/);
  assert.match(app, /SIDEBAR_MAX/);
});

test("the stylesheet has balanced braces", async () => {
  // A stray `}` silently discards every rule after it, which is how the
  // sidebar buttons stopped responding and the thinking block stopped
  // centring: the CSS parsed, the browser reported no error, and the rules
  // simply were not there. Braces are the one structural property a stylesheet
  // can be checked for without a browser.
  const css = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/styles.css", "utf8"));
  let depth = 0;
  let line = 1;
  const problems: string[] = [];
  for (const char of css) {
    if (char === "\n") line++;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth < 0) {
        problems.push(`extra } on line ${line}`);
        depth = 0;
      }
    }
  }
  if (depth !== 0) problems.push(`${depth} unclosed block(s) at end of file`);
  assert.deepEqual(problems, []);
});

test("the rewind action is laid out beside the bubble, not over it", async () => {
  // The button used to be absolutely positioned at `right: 28px` inside the
  // turn, which landed on top of the user bubble. The fix is structural: the
  // turn is a flex row, so the two cannot overlap at any bubble width.
  const css = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/styles.css", "utf8"));
  const turnRule = /\.turn\.user\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(turnRule, /display:\s*flex/);
  assert.match(turnRule, /justify-content:\s*flex-end/);
  const rewind = /\.rewind-button\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(!/position:\s*absolute/.test(rewind), "the rewind button must not be positioned over the bubble");
  // The bubble hands alignment to the flex row.
  assert.match(css, /\.turn\.user \.user-bubble\s*\{[^}]*float:\s*none/);
});

test("the user turn has no clearfix pseudo-element inside its flex row", async () => {
  // `.turn.user::after { clear: both }` was a clearfix for the floated bubble.
  // Once the turn became a flex row the pseudo-element turned into a third
  // flex item, which pushed the bubble sideways and made consecutive user
  // messages overlap. A flex container does not need a clearfix.
  const css = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/styles.css", "utf8"));
  assert.ok(!/\.turn\.user::after\s*\{[^}]*clear:\s*both/.test(css), "a clearfix inside the flex row breaks its layout");
});

test("the rewind button is ordered before the bubble so right edges line up", async () => {
  // `attachRewind` appends the button after the bubble. In a flex row with
  // `justify-content: flex-end`, that made the button the right-most item, so
  // a turn with a button had its bubble stop short of the right edge while a
  // turn without one reached it — consecutive messages looked ragged.
  const css = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/styles.css", "utf8"));
  const rewind = /\.rewind-button\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rewind, /order:\s*-1/, "the button must sit before the bubble in the flex row");
});

test("the progress line reports output tokens only and clears with the turn", async () => {
  const app = await import("node:fs").then((fs) => fs.readFileSync("desktop/renderer/app.js", "utf8"));
  const host = await import("node:fs").then((fs) => fs.readFileSync("desktop/host.js", "utf8"));
  // Output tokens are the figure that measures the answer. The total included
  // the prompt, which on the first heartbeat was six figures and read as a
  // runaway bill rather than as progress.
  assert.match(host, /outputTokens:\s*usage\.outputTokens/);
  assert.ok(!/tokens:\s*usage\.inputTokens \+ usage\.outputTokens/.test(host), "the prompt tokens must not be in the live readout");
  assert.match(app, /progress\.outputTokens > 0/);
  // The line is created and removed with the turn, never left behind.
  assert.match(app, /function ensureProgress/);
  assert.match(app, /function clearProgress/);
  assert.match(app, /if \(busy\) \{[\s\S]{0,200}startProgressTicker\(\)/);
  assert.match(app, /else \{\s*clearProgress\(\);/);
  // No sentence explaining the gateway's buffering: the spinner and the count
  // already say "working".
  assert.ok(!/progressServerQuiet|progressWaiting|progressStreaming/.test(app), "the progress line is not a status essay");
});
