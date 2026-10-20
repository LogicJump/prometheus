/**
 * Round 9, batch 1: four features that never worked.
 *
 * Each of these was a promise the interface made and the code did not keep:
 * two buttons that could only fail, a drag-and-drop that rejected every file,
 * a "reopen last session" that never fired, and a sidebar filter the host
 * threw away. The tests below drive the real code rather than matching
 * strings, except where the behaviour lives in the renderer's event handlers,
 * which cannot be imported outside a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runIdFromCheckUrl, rerunFailedChecks, failedCheckLog, setGhRunner } from "../desktop/git.js";
import { shouldRestoreSession } from "../desktop/renderer/startup.js";
import { filterSessions, resolveSessionView, EMPTY_SESSION_VIEW } from "../desktop/sessionView.js";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const preload = readFileSync("desktop/preload.cjs", "utf8");
const host = readFileSync("desktop/host.js", "utf8");

/* ---------- U7: the two buttons that could only fail ---------- */

test("a check URL yields the Actions run id", () => {
  assert.equal(runIdFromCheckUrl("https://github.com/o/r/actions/runs/12345678/job/87654321"), "12345678");
  assert.equal(runIdFromCheckUrl("https://github.com/o/r/actions/runs/42"), "42");
});

test("a check with no Actions run yields nothing to rerun", () => {
  // A third-party check has a link to its own dashboard; `gh run rerun` has no
  // run to act on, and guessing one would rerun somebody else's workflow.
  assert.equal(runIdFromCheckUrl("https://circleci.com/gh/o/r/123"), "");
  assert.equal(runIdFromCheckUrl(""), "");
  assert.equal(runIdFromCheckUrl(null), "");
});

function fakeChecks(checks: unknown[]) {
  const calls: string[][] = [];
  setGhRunner(async (_cwd, args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "checks") return { ok: true, stdout: JSON.stringify(checks), stderr: "" };
    if (args[0] === "run" && args[1] === "rerun") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "run" && args[1] === "view") return { ok: true, stdout: "line 1\nline 2\n", stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  });
  return calls;
}

test("rerunning failed checks passes the run id and never a bare run rerun", async () => {
  const calls = fakeChecks([
    { name: "build", state: "SUCCESS", link: "https://github.com/o/r/actions/runs/111/job/1" },
    { name: "test", state: "FAILURE", link: "https://github.com/o/r/actions/runs/222/job/2" },
    { name: "lint", state: "FAILURE", link: "https://github.com/o/r/actions/runs/222/job/3" },
  ]);
  try {
    const result = await rerunFailedChecks("G:/repo", 7);
    assert.equal(result.ok, true, result.error);
    const reruns = calls.filter((args) => args[0] === "run" && args[1] === "rerun");
    assert.deepEqual(reruns, [["run", "rerun", "222", "--failed"]], "one rerun per failing run, with the id");
  } finally {
    setGhRunner(null);
  }
});

test("a failing check outside Actions is reported, not silently skipped", async () => {
  fakeChecks([{ name: "external", state: "FAILURE", link: "https://ci.example.com/build/9" }]);
  try {
    const result = await rerunFailedChecks("G:/repo", 7);
    assert.equal(result.ok, false);
    assert.match(result.error, /run id|Actions/i);
  } finally {
    setGhRunner(null);
  }
});

test("the failed log is fetched by run id without gh's invalid --limit", async () => {
  const calls = fakeChecks([
    { name: "test", state: "FAILURE", link: "https://github.com/o/r/actions/runs/333/job/4" },
  ]);
  try {
    const result = await failedCheckLog("G:/repo", 7);
    assert.equal(result.ok, true, result.error);
    const view = calls.find((args) => args[0] === "run" && args[1] === "view");
    assert.ok(view, "run view was called");
    assert.deepEqual(view, ["run", "view", "333", "--log-failed"], "run id positional, no --limit");
    assert.match(result.log, /line 1/);
  } finally {
    setGhRunner(null);
  }
});

test("the failed log is truncated locally, since gh cannot do it", async () => {
  setGhRunner(async (_cwd, args) => {
    if (args[0] === "pr") {
      return {
        ok: true,
        stdout: JSON.stringify([{ name: "test", state: "FAILURE", link: "https://github.com/o/r/actions/runs/9/job/1" }]),
        stderr: "",
      };
    }
    return { ok: true, stdout: "x".repeat(500), stderr: "" };
  });
  try {
    const result = await failedCheckLog("G:/repo", 7, 100);
    assert.equal(result.ok, true);
    assert.ok(result.log.length < 200, "the body is cut to the asked length");
    assert.match(result.log, /truncated/);
  } finally {
    setGhRunner(null);
  }
});

/* ---------- U8: dropped files ---------- */

test("the preload exposes the Electron 44 way to read a dropped file's path", () => {
  assert.match(preload, /webUtils/, "webUtils is imported from electron");
  assert.match(preload, /getPathForFile/, "the bridge exposes it by name");
});

test("the renderer asks the bridge for a path instead of reading file.path", () => {
  // `File.path` was removed in Electron 32; every dropped log or markdown file
  // was rejected with "unsupported" because the value was undefined.
  const start = app.indexOf("function handleImageFiles");
  assert.ok(start > -1, "handleImageFiles exists");
  const body = app.slice(start, start + 1600);
  assert.match(body, /getPathForFile/, "the bridge is used");
  assert.ok(!/const path = file\.path/.test(body), "the removed property is not the primary source");
});

/* ---------- U9: reopening the last session ---------- */

test("a remembered session that differs from the fresh one is reopened", () => {
  assert.equal(shouldRestoreSession({ remembered: "s-old", current: "s-new", enabled: true }), "s-old");
});

test("no restore when the setting is off, nothing is remembered, or it is already open", () => {
  assert.equal(shouldRestoreSession({ remembered: "s-old", current: "s-new", enabled: false }), "");
  assert.equal(shouldRestoreSession({ remembered: "", current: "s-new", enabled: true }), "");
  assert.equal(shouldRestoreSession({ remembered: "s-new", current: "s-new", enabled: true }), "");
  assert.equal(shouldRestoreSession({ remembered: null, current: "s-new", enabled: true }), "");
});

test("the fresh session's state event no longer overwrites the remembered id", () => {
  // The host emits `state` for the auto-created session before `ready`; writing
  // that id into `lastSession` made the comparison in `ready` always equal.
  const start = app.indexOf('case "state":');
  const end = app.indexOf('case "board_state"', start);
  assert.ok(start > -1 && end > start);
  const body = app.slice(start, end);
  assert.ok(!/localStorage\.setItem\(\s*"prometheus\.lastSession"/.test(body), "state does not write the remembered session");
  assert.match(app, /shouldRestoreSession/, "ready asks the helper");
});

test("loading or saving a session is what records it for next time", () => {
  const loaded = app.slice(app.indexOf('case "session_loaded"'), app.indexOf('case "session_saved"'));
  const saved = app.slice(app.indexOf('case "session_saved"'), app.indexOf('case "session_saved"') + 900);
  assert.ok(loaded.includes("prometheus.lastSession"), "a loaded session becomes the one to remember");
  assert.ok(saved.includes("prometheus.lastSession"), "a saved session becomes the one to remember");
});

/* ---------- U10: the sidebar filter ---------- */

const sessions = [
  { id: "a", status: "ready", cwd: "G:/one" },
  { id: "b", status: "error", cwd: "G:/one" },
  { id: "c", status: "error", cwd: "G:/two" },
  { id: "d", cwd: "G:/two" },
];

test("the host filters by status", () => {
  const view = resolveSessionView(EMPTY_SESSION_VIEW, { status: "error" });
  assert.deepEqual(filterSessions(sessions, view).map((s) => s.id), ["b", "c"]);
});

test("a session with no stored status counts as ready", () => {
  const view = resolveSessionView(EMPTY_SESSION_VIEW, { status: "ready" });
  assert.deepEqual(filterSessions(sessions, view).map((s) => s.id), ["a", "d"]);
});

test("the host filters by workspace", () => {
  const view = resolveSessionView(EMPTY_SESSION_VIEW, { cwd: "G:/two" });
  assert.deepEqual(filterSessions(sessions, view).map((s) => s.id), ["c", "d"]);
});

test("workspace comparison ignores case and separators", () => {
  const view = resolveSessionView(EMPTY_SESSION_VIEW, { cwd: "g:\\two\\" });
  assert.deepEqual(filterSessions(sessions, view).map((s) => s.id), ["c", "d"]);
});

test("a later push keeps the filter the user chose", () => {
  // `sendSessions()` with no options used to reset the view to "all", so the
  // next status change put the failures back into a "only errors" list.
  const chosen = resolveSessionView(EMPTY_SESSION_VIEW, { status: "error", cwd: "G:/one" });
  const pushed = resolveSessionView(chosen, {});
  assert.equal(pushed.status, "error");
  // The stored form is canonical; what matters is that it still names the same
  // folder and still filters to it.
  assert.deepEqual(filterSessions(sessions, pushed).map((s) => s.id), ["b"]);
});

test("the listSessions command passes the filter through instead of dropping it", () => {
  const start = host.indexOf('case "listSessions":');
  assert.ok(start > -1);
  const body = host.slice(start, start + 400);
  assert.match(body, /cmd\.status/, "status reaches sendSessions");
  assert.match(body, /cmd\.cwd/, "cwd reaches sendSessions");
});
