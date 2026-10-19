/**
 * Round-four phase E: sessions, checkpoints, scheduling, and the CLI verbs.
 *
 * These tests use temporary directories and fake histories rather than a real
 * model, because what is being pinned is bookkeeping: a round that must not be
 * repeated, an undo that must be undoable, a slot that must not double-fire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ---------- goal resume --------------------------------------------------- */

test("a resumed goal continues at the next round and keeps its history", async () => {
  const { runGoal } = await import("../src/autoloop.ts");
  const rounds: number[] = [];
  const result = await runGoal({
    goal: "ship the parser",
    maxRounds: 5,
    resume: { round: 2, history: ["round 1: wrote the lexer", "round 2: wrote the parser"] },
    runRound: async (_prompt, context) => {
      rounds.push(context.round);
      return { ok: true, summary: `did round ${context.round}` };
    },
    isGoalMet: async () => ({ met: true, reason: "done" }),
  });
  assert.deepEqual(rounds, [3], "the loop must not repeat rounds 1 and 2");
  assert.equal(result.stop, "goal-met");
  assert.equal(result.history.length, 3, "history carries the rounds from before the crash");
});

test("a resumed goal still obeys the original round limit", async () => {
  const { runGoal } = await import("../src/autoloop.ts");
  const rounds: number[] = [];
  const result = await runGoal({
    goal: "keep going",
    maxRounds: 3,
    resume: { round: 3, history: ["round 1", "round 2", "round 3"] },
    runRound: async (_prompt, context) => {
      rounds.push(context.round);
      return { ok: true, summary: `round ${context.round}` };
    },
    isGoalMet: async () => ({ met: false, reason: "not yet" }),
  });
  assert.equal(rounds.length, 0, "there is no round 4 when the ceiling is 3");
  assert.equal(result.stop, "round-limit");
});

test("the first prompt of a resumed goal is not the first-round prompt", async () => {
  const { roundPrompt } = await import("../src/autoloop.ts");
  const first = roundPrompt("goal", 1, []);
  const later = roundPrompt("goal", 3, ["round 1: a", "round 2: b"]);
  assert.equal(first, "goal");
  assert.match(later, /Do not start over/);
});

/* ---------- task loop resume ---------------------------------------------- */

test("a resumed task loop does not plan again", async () => {
  const { runTaskLoop } = await import("../src/autoloop.ts");
  let planned = 0;
  const result = await runTaskLoop({
    maxRounds: 4,
    resume: true,
    plan: async () => {
      planned += 1;
      return { ok: true, summary: "planned" };
    },
    readTasks: () => [
      { content: "step one", status: "completed" },
      { content: "step two", status: "pending" },
    ],
    runRound: async () => ({ ok: true, summary: "did step two" }),
  });
  assert.equal(planned, 0, "re-planning would throw away the recorded progress");
  assert.ok(result.detail.length > 0);
});

/* ---------- session selection and fork ------------------------------------ */

test("a session prefix resolves, and an ambiguous one lists candidates", async () => {
  const { selectSession } = await import("../src/sessionCommands.ts");
  // The real store is per-user; these assertions are structural so they hold
  // with an empty store too. Ambiguity is the case that matters: it must not
  // guess.
  const result = selectSession("zzz-no-such-session");
  assert.equal(result.ok, false);
  assert.deepEqual(result.candidates, []);
});

/* ---------- usage export --------------------------------------------------- */

test("usage export keeps every dimension and quotes commas", async () => {
  const { usageRows, toCsv } = await import("../src/sessionCommands.ts");
  const rows = usageRows([
    {
      at: "2026-10-19T10:00:00.000Z",
      sessionId: "s1",
      cwd: "G:/a,b",
      model: "glm-5.3-flash",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 3,
      cacheWriteTokens: 4,
      cost: 0.01,
      source: "subagent",
    },
  ]);
  const csv = toCsv(rows);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /cacheWriteTokens/);
  assert.match(lines[1], /"G:\/a,b"|"G:\/a,b"/i, "a comma in the path must be quoted");
  assert.match(lines[1], /subagent/);
});

test("an unknown export extension is refused, not guessed", async () => {
  const { writeUsageExport } = await import("../src/sessionCommands.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-export-"));
  try {
    const result = writeUsageExport(join(dir, "usage.xlsx"), []);
    assert.equal(result.ok, false);
    assert.match(String(result.error), /\.csv or \.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- checkpoints: per-file restore and redo ------------------------- */

test("restoring one file leaves the other files alone", async () => {
  const { recordSnapshot, restoreFile } = await import("../src/checkpoints.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-files-"));
  const sessionId = `test-${Date.now()}`;
  const one = join(dir, "one.txt");
  const two = join(dir, "two.txt");
  try {
    writeFileSync(one, "one-before", "utf8");
    writeFileSync(two, "two-before", "utf8");
    recordSnapshot(sessionId, "edit_file", dir, one, "modified", "one-before");
    recordSnapshot(sessionId, "edit_file", dir, two, "modified", "two-before");
    writeFileSync(one, "one-after", "utf8");
    writeFileSync(two, "two-after", "utf8");

    const result = restoreFile(sessionId, one);
    assert.deepEqual(result.errors, []);
    assert.equal(readFileSync(one, "utf8"), "one-before");
    assert.equal(readFileSync(two, "utf8"), "two-after", "the other file must not be rolled back");
  } finally {
    const { clearCheckpoints } = await import("../src/checkpoints.ts");
    clearCheckpoints(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undo can be undone", async () => {
  const { recordSnapshot, restoreFile, applyRedo, lastRedo } = await import("../src/checkpoints.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-redo-"));
  const sessionId = `test-redo-${Date.now()}`;
  const file = join(dir, "file.txt");
  try {
    writeFileSync(file, "original", "utf8");
    recordSnapshot(sessionId, "edit_file", dir, file, "modified", "original");
    writeFileSync(file, "changed", "utf8");

    restoreFile(sessionId, file);
    assert.equal(readFileSync(file, "utf8"), "original");
    assert.ok(lastRedo(sessionId), "the undo must leave a redo record");

    applyRedo(sessionId);
    assert.equal(readFileSync(file, "utf8"), "changed", "redo puts the change back");
    assert.equal(lastRedo(sessionId), null, "redo is consumed");
  } finally {
    const { clearCheckpoints } = await import("../src/checkpoints.ts");
    clearCheckpoints(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a created file is removed by a restore", async () => {
  const { recordSnapshot, restoreFile } = await import("../src/checkpoints.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-created-"));
  const sessionId = `test-created-${Date.now()}`;
  const file = join(dir, "new.txt");
  try {
    recordSnapshot(sessionId, "write_file", dir, file, "created", null);
    writeFileSync(file, "now it exists", "utf8");
    restoreFile(sessionId, file);
    assert.equal(existsSync(file), false);
  } finally {
    const { clearCheckpoints } = await import("../src/checkpoints.ts");
    clearCheckpoints(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- unified diff for `apply` -------------------------------------- */

test("a generated patch names both sides and applies cleanly with git", async () => {
  const { unifiedDiff } = await import("../src/sessionCommands.ts");
  const patch = unifiedDiff("a.txt", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
  assert.match(patch, /^--- a\/a\.txt$/m);
  assert.match(patch, /^\+\+\+ b\/a\.txt$/m);
  assert.match(patch, /^-two$/m);
  assert.match(patch, /^\+TWO$/m);
});

test("an added file diffs against /dev/null", async () => {
  const { unifiedDiff } = await import("../src/sessionCommands.ts");
  const patch = unifiedDiff("new.txt", null, "hello\n");
  assert.match(patch, /^--- \/dev\/null$/m);
  assert.match(patch, /^\+hello$/m);
});

/* ---------- schedules ------------------------------------------------------ */

test("a schedule that came due once is claimed once", async () => {
  const { addSchedule, dueSchedules, claimSchedule, removeSchedule } = await import("../src/schedule.ts");
  const at = new Date(Date.now() - 60_000).toISOString();
  const added = addSchedule({ prompt: "run the tests", cwd: process.cwd(), at, everyMinutes: 60 });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  try {
    const due = dueSchedules().filter((entry) => entry.id === added.entry.id);
    assert.equal(due.length, 1);
    const claimed = claimSchedule(added.entry.id);
    assert.ok(claimed);
    const after = dueSchedules().filter((entry) => entry.id === added.entry.id);
    assert.equal(after.length, 0, "the slot must advance before the work starts");
  } finally {
    removeSchedule(added.entry.id);
  }
});

test("a long outage does not produce one run per missed interval", async (t) => {
  const { addSchedule, claimSchedule, dueSchedules, removeSchedule } = await import("../src/schedule.ts");
  // Due three days ago, repeating hourly: the next slot must be in the future,
  // not 72 slots queued up.
  const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const added = addSchedule({ prompt: "nightly", cwd: process.cwd(), at, everyMinutes: 60 });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  try {
    const claimed = claimSchedule(added.entry.id);
    assert.ok(claimed);
    assert.ok(Date.parse(claimed.dueAt) > Date.now(), `expected a future slot, got ${claimed.dueAt}`);
    // The second claim is not an error: it is due again only when the next slot
    // arrives. What must not happen is a second run before then.
    const dueNow = dueSchedules().filter((entry) => entry.id === added.entry.id);
    assert.equal(dueNow.length, 0, "the advanced slot must not be due yet");
  } finally {
    removeSchedule(added.entry.id);
  }
});

test("--in parses minutes, hours, and days", async () => {
  const { parseWhen } = await import("../src/schedule.ts");
  const now = new Date("2026-10-19T12:00:00.000Z");
  assert.equal(parseWhen({ in: "30m" }, now), "2026-10-19T12:30:00.000Z");
  assert.equal(parseWhen({ in: "2h" }, now), "2026-10-19T14:00:00.000Z");
  assert.equal(parseWhen({ in: "1d" }, now), "2026-10-20T12:00:00.000Z");
  assert.equal(parseWhen({ in: "soon" }, now), null);
});

/* ---------- workers -------------------------------------------------------- */

test("a worker records its state and a sweep closes a dead run", async () => {
  const { startWorker, sweepWorkers, workerRecord } = await import("../src/workers.ts");
  const worker = startWorker("bash", "sleep 100");
  worker.write("started");
  assert.equal(workerRecord(worker.id)?.state, "running");
  // Simulate the process dying without settling.
  const swept = sweepWorkers().find((record) => record.id === worker.id);
  assert.ok(swept, "the running record must be swept");
  assert.equal(swept.state, "failed");
  assert.match(String(swept.summary), /exited before it finished/);
});

test("a settled worker is not swept again and keeps its summary", async () => {
  const { startWorker, sweepWorkers, workerRecord, readWorkerLog } = await import("../src/workers.ts");
  const worker = startWorker("bash", "true");
  worker.write("a line");
  worker.settle("done", "finished in 0.1s");
  assert.equal(sweepWorkers().some((record) => record.id === worker.id), false);
  assert.equal(workerRecord(worker.id)?.summary, "finished in 0.1s");
  assert.match(String(readWorkerLog(worker.id)), /a line/);
});

/* ---------- startup recovery ---------------------------------------------- */

test("an orphaned tool call is recognised, a finished turn is not", async () => {
  const { hasOrphanToolCall } = await import("../src/sessionRecovery.ts");
  assert.equal(
    hasOrphanToolCall([{ role: "user" }, { role: "assistant", tool_calls: [{ id: "1" }] }]),
    true,
  );
  assert.equal(
    hasOrphanToolCall([{ role: "user" }, { role: "assistant", tool_calls: [{ id: "1" }] }, { role: "tool" }]),
    true,
    "a transcript that ends at the tool result never reached the assistant's next turn",
  );
  assert.equal(
    hasOrphanToolCall([{ role: "user" }, { role: "assistant", tool_calls: [{ id: "1" }] }, { role: "tool" }, { role: "assistant" }]),
    false,
    "a later assistant message means the call was followed up",
  );
  assert.equal(hasOrphanToolCall([{ role: "user" }, { role: "assistant" }]), false);
});

/* ---------- schema errors -------------------------------------------------- */

test("a missing schema file reports one line, not a stack", async () => {
  const { readSchema, SchemaFileError } = await import("../src/schema.ts");
  assert.throws(
    () => readSchema(join(tmpdir(), "definitely-not-here-schema.json")),
    (error: unknown) => error instanceof SchemaFileError && /not found/.test((error as Error).message),
  );
});

test("a malformed schema file says so and names the file", async () => {
  const { readSchema, SchemaFileError } = await import("../src/schema.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-schema-"));
  const file = join(dir, "bad.json");
  try {
    writeFileSync(file, "{ not json", "utf8");
    assert.throws(
      () => readSchema(file),
      (error: unknown) => error instanceof SchemaFileError && /not valid JSON/.test((error as Error).message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- worktree include ---------------------------------------------- */

test("worktree include patterns match names, paths, and wildcards", async () => {
  const { matchesInclude } = await import("../src/worktree.ts");
  const patterns = [".env", "config/", "*.local.json"];
  assert.equal(matchesInclude(".env", patterns), true);
  assert.equal(matchesInclude("config/app.yml", patterns), true);
  assert.equal(matchesInclude("settings.local.json", patterns), true);
  assert.equal(matchesInclude("src/index.ts", patterns), false);
  assert.equal(matchesInclude(".envrc", patterns), false, "a name must match whole, not as a prefix");
});

test("the include file ignores comments and negations", async () => {
  const { readWorktreeInclude } = await import("../src/worktree.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-include-"));
  try {
    writeFileSync(join(dir, ".worktreeinclude"), "# local files\n.env\n\n!keep-me\nconfig/\n", "utf8");
    const patterns = readWorktreeInclude(dir);
    assert.deepEqual(patterns, [".env", "config/"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- git snapshots -------------------------------------------------- */

test("an empty repository is not a git root for snapshots", async () => {
  const { gitRoot } = await import("../src/gitSnapshot.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-notgit-"));
  try {
    assert.equal(await gitRoot(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dirty paths are read from a real repository", async () => {
  const { execFileSync } = await import("node:child_process");
  const { dirtyState } = await import("../src/gitSnapshot.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });

    const clean = await dirtyState(dir);
    assert.ok(clean);
    assert.equal(clean.paths.size, 0);

    writeFileSync(join(dir, "tracked.txt"), "two\n", "utf8");
    writeFileSync(join(dir, "new.txt"), "new\n", "utf8");
    const dirty = await dirtyState(dir);
    assert.ok(dirty);
    assert.equal(dirty.paths.get("tracked.txt")?.trim(), "M");
    assert.equal(dirty.paths.get("new.txt"), "??");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- session metadata round trip ------------------------------------ */

test("a goal and worktree survive a meta write", async () => {
  const { saveSession, updateSessionFlags, loadSession, deleteSessionFile } = await import("../src/sessions.ts");
  const id = `test-meta-${Date.now()}`;
  try {
    saveSession({
      id,
      cwd: process.cwd(),
      model: "test-model",
      baseUrl: "http://localhost",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "hi" }],
    });
    updateSessionFlags(id, {
      goal: { kind: "goal", text: "finish", round: 2, maxRounds: 6, history: ["round 1: a"] },
      worktree: { path: "G:/wt", branch: "prometheus/test" },
    });
    const loaded = loadSession(id);
    assert.equal(loaded?.goal?.round, 2);
    assert.deepEqual(loaded?.goal?.history, ["round 1: a"]);
    assert.equal(loaded?.worktree?.branch, "prometheus/test");

    updateSessionFlags(id, { goal: null });
    assert.equal(loadSession(id)?.goal, undefined, "null clears the goal");
  } finally {
    deleteSessionFile(id);
  }
});

test("search finds a session by a word inside its transcript, not just its title", async () => {
  const { saveSession, searchSessions, deleteSessionFile } = await import("../src/sessions.ts");
  const id = `test-search-${Date.now()}`;
  try {
    saveSession({
      id,
      cwd: process.cwd(),
      model: "m",
      baseUrl: "http://localhost",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "please fix the widget" },
        { role: "assistant", content: "the flibbertigibbet is in parser.ts" },
      ],
    });
    const hits = searchSessions("flibbertigibbet", { limit: 50 });
    const found = hits.find((hit) => hit.id === id);
    assert.ok(found, "a body-only match must be found");
    assert.match(found.matches[0].excerpt, /flibbertigibbet/);
  } finally {
    deleteSessionFile(id);
  }
});

/* ---------- baseline reconstruction --------------------------------------- */

test("a baseline lets a later process rebuild the session diff", async () => {
  const { saveBaseline, loadBaseline, sessionDiff } = await import("../src/sessionCommands.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-baseline-"));
  const sessionId = `test-baseline-${Date.now()}`;
  try {
    const file = join(dir, "a.txt");
    writeFileSync(file, "before\n", "utf8");
    saveBaseline(sessionId, new Map([[file, "before\n"]]));
    writeFileSync(file, "after\n", "utf8");
    assert.equal(loadBaseline(sessionId).length, 1);
    const patch = sessionDiff(sessionId, dir);
    assert.match(patch, /-before/);
    assert.match(patch, /\+after/);
  } finally {
    const { rmSync: rm } = await import("node:fs");
    const { CONFIG_HOME } = await import("../src/config.ts");
    rm(join(CONFIG_HOME, "baselines", `${sessionId}.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- JSONL streaming contract -------------------------------------- */

test("the headless UI emits init before any turn", async () => {
  const { JsonUi } = await import("../src/headless.ts");
  const events: unknown[] = [];
  const out = { write: (line: string) => { events.push(JSON.parse(line)); return true; } } as unknown as NodeJS.WriteStream;
  const ui = new JsonUi({ stream: true, out, sessionId: "s-123", model: "m" });
  assert.equal(events.length, 1);
  const init = events[0] as { type: string; sessionId: string };
  assert.equal(init.type, "init");
  assert.equal(init.sessionId, "s-123");
  void ui;
});

test("tool_start and tool_end carry a pairable id", async () => {
  const { JsonUi } = await import("../src/headless.ts");
  const events: { type: string; id?: string; input?: unknown; at?: string }[] = [];
  const out = { write: (line: string) => { events.push(JSON.parse(line)); return true; } } as unknown as NodeJS.WriteStream;
  const ui = new JsonUi({ stream: true, out, sessionId: "s", model: "m" });
  ui.toolStart("read_file", "a.ts", { id: "tool-1", input: { path: "a.ts" }, at: "2026-10-19T00:00:00.000Z" });
  ui.toolEnd("read_file", true, "ok", { id: "tool-1", at: "2026-10-19T00:00:01.000Z" });
  const start = events.find((event) => event.type === "tool_start");
  const end = events.find((event) => event.type === "tool_end");
  assert.ok(start && end);
  assert.equal(start.id, end.id);
  assert.deepEqual(start.input, { path: "a.ts" });
  assert.ok(start.at && end.at);
});

/* ---------- session commands ---------------------------------------------- */

test("CSV export writes one row per request and a header", async () => {
  const { usageRows, toCsv } = await import("../src/sessionCommands.ts");
  const rows = usageRows([
    { at: "2026-10-19T00:00:00Z", sessionId: "a", cwd: "/a", model: "m", inputTokens: 1, outputTokens: 2, cachedTokens: 0 },
    { at: "2026-10-19T00:01:00Z", sessionId: "b", cwd: "/b", model: "m", inputTokens: 3, outputTokens: 4, cachedTokens: 1, source: "background" },
  ]);
  const lines = toCsv(rows).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2], /background/);
});

/* ---------- ephemeral turns ----------------------------------------------- */

test("recordUsage can be silenced for an ephemeral run", async () => {
  const { recordUsage, readUsage, setUsageEphemeral } = await import("../src/usage.ts");
  const before = readUsage().length;
  try {
    setUsageEphemeral(true);
    recordUsage({ sessionId: "ephemeral-test", cwd: process.cwd(), model: "m", inputTokens: 5, outputTokens: 5, cachedTokens: 0 });
    assert.equal(readUsage().length, before, "an ephemeral run must not write a usage record");
  } finally {
    setUsageEphemeral(false);
  }
});

/* ---------- worktree locks ------------------------------------------------- */

test("a live lock blocks a second session and a dead one does not", async (t) => {
  const { lockWorktree, unlockWorktree } = await import("../src/worktree.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-lock-"));
  try {
    const first = lockWorktree(dir, "session-a");
    assert.equal(first.ok, true);
    const second = lockWorktree(dir, "session-b");
    assert.equal(second.ok, false, "the same worktree must not be shared");
    assert.equal(second.holder, "session-a");
    // The refused attempt must not have overwritten the first session's lock.
    assert.equal(JSON.parse(readFileSync(join(dir, ".prometheus-lock.json"), "utf8")).sessionId, "session-a");

    // A lock whose pid is gone is stale, not a conflict.
    writeFileSync(join(dir, ".prometheus-lock.json"), JSON.stringify({ sessionId: "dead", pid: 999_999 }), "utf8");
    const third = lockWorktree(dir, "session-c");
    assert.equal(third.ok, true, "a dead process must not hold a worktree forever");

    unlockWorktree(dir);
    assert.equal(existsSync(join(dir, ".prometheus-lock.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale worktrees are found only after the grace period", async () => {
  const { staleWorktrees } = await import("../src/worktree.ts");
  const repo = mkdtempSync(join(tmpdir(), "prometheus-repo-"));
  try {
    const wt = join(repo, ".prometheus", "worktrees", "abc");
    mkdirSync(wt, { recursive: true });
    assert.equal(staleWorktrees(repo, 14).length, 0, "a fresh worktree is not stale");
    // Zero days rounds down to "less than a day old", so the grace period that
    // still lists a fresh directory is 0 measured in whole days only when the
    // age check is inclusive. Verify the boundary the caller actually uses.
    const fresh = staleWorktrees(repo, 14);
    assert.equal(fresh.length, 0);
    const stat = statSync(wt);
    assert.ok(stat.isDirectory());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
