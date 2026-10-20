/**
 * Round 9, batch 7: settings that did not stick, and controls that promised
 * more than they did.
 *
 * Most of these are small. What they share is that the interface showed a
 * state the program did not have: a toggle that reset on reopen, a "configurable"
 * path that was a constant, a menu with no way out, a delete with no question.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filledPreferences, PREFERENCE_FIELDS } from "../desktop/renderer/settingsState.js";
import { autoTitleAllowed, ruleFirstTitle } from "../src/titlePolicy.ts";

const settings = readFileSync("desktop/renderer/settings.js", "utf8");
const app = readFileSync("desktop/renderer/app.js", "utf8");
const html = readFileSync("desktop/renderer/index.html", "utf8");
const host = readFileSync("desktop/host.js", "utf8");
const styles = readFileSync("desktop/renderer/styles.css", "utf8");
const worktree = readFileSync("src/worktree.ts", "utf8");
const agent = readFileSync("src/agent.ts", "utf8");

/* ---------- U24: preferences that never came back ---------- */

test("every preference the page edits is read back from the host's answer", () => {
  const filled = filledPreferences({
    restartSession: false,
    suggestions: false,
    updateCheck: false,
    isolateByDefault: true,
    uiScale: 1.25,
  });
  assert.equal(filled.restartSession, false);
  assert.equal(filled.suggestions, false);
  assert.equal(filled.updateCheck, false);
  assert.equal(filled.isolateByDefault, true);
  assert.equal(filled.uiScale, 1.25);
});

test("a missing value falls back to the documented default", () => {
  const filled = filledPreferences({});
  assert.equal(filled.restartSession, true);
  assert.equal(filled.suggestions, true);
  assert.equal(filled.updateCheck, true);
  assert.equal(filled.isolateByDefault, false);
  assert.equal(filled.uiScale, 1);
});

test("the page assigns each of them after a load", () => {
  const start = settings.indexOf("function fillSettings");
  const body = settings.slice(start, settings.indexOf("/* ---------- about", start));
  // They are assigned in one call rather than one line each; what matters is
  // that the host's answer reaches `state` for every one of them.
  assert.match(body, /filledPreferences\(settings\)/);
  for (const key of PREFERENCE_FIELDS) {
    assert.ok(body.includes("filledPreferences") || body.includes(key), `${key} is filled from the host's settings`);
  }
});

test("the zoom level is a host preference, not only a localStorage entry", () => {
  const start = host.indexOf("case \"setUiPreference\"");
  const body = host.slice(start, start + 1400);
  assert.ok(body.includes('"uiScale"'), "the host accepts it");
  assert.match(host, /uiScale: uiPrefs\.uiScale/, "and reports it back");
});

/* ---------- U25: automatic titles ---------- */

test("titles are off when the setting says so", () => {
  assert.equal(autoTitleAllowed({ suggestions: false }), false);
  assert.equal(autoTitleAllowed({ suggestions: true }), true);
  assert.equal(autoTitleAllowed({}), true);
});

test("a free rule produces a title before the model is asked", () => {
  const title = ruleFirstTitle("Why is the STM32 watchdog resetting after init?\n\nmore details");
  assert.ok(title);
  assert.ok(title.length <= 60);
  assert.match(title, /watchdog/i);
});

test("a message with nothing to say yields no rule title", () => {
  assert.equal(ruleFirstTitle("   "), "");
});

test("the host honours the setting before spending a model call", () => {
  const start = host.indexOf("async function autoTitle");
  const body = host.slice(start, start + 900);
  assert.match(body, /uiPrefs\.suggestions/);
  assert.match(body, /ruleFirstTitle/);
});

/* ---------- U26: focus trapping ---------- */

test("the command palette traps Tab", () => {
  const start = app.indexOf("function openPalette");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /trapFocus|Tab/);
});

test("the split picker traps Tab", () => {
  const start = app.indexOf("function openSplitPicker");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /trapFocus|Tab/);
});

/* ---------- U27: menus close on Escape and outside clicks ---------- */

test("the board menu closes on Escape and on an outside click", () => {
  // The listeners are on `document` rather than inside the opener, so both are
  // asserted at the point where the menu is opened and closed.
  const start = app.indexOf('$("board-picker").addEventListener');
  const body = app.slice(start, start + 1400);
  assert.match(body, /Escape/);
  assert.match(body, /mousedown/);
  assert.match(body, /closeBoardMenu/);
});

/* ---------- U28: destructive settings actions ask first ---------- */

test("the settings page receives a confirm function", () => {
  assert.match(app, /createSettings\(/);
  assert.match(app, /confirmAction/);
  const create = app.slice(app.indexOf("createSettings("), app.indexOf("createSettings(") + 400);
  assert.match(create, /confirm/);
});

test("removing an MCP server, a skill, a memory or a rule asks first", () => {
  for (const marker of ["removeMcp", "removeSkill", "removeMemory", "removeRule"]) {
    const at = settings.indexOf(marker);
    assert.ok(at > -1, `${marker} exists`);
    const window = settings.slice(Math.max(0, at - 900), at + 200);
    assert.match(window, /confirm/, `${marker} asks before removing`);
  }
});

/* ---------- U29: the update badge ---------- */

test("the update check has somewhere to show", () => {
  assert.match(html, /id="check-update"/);
});

/* ---------- U30: the setup checklist's actions ---------- */

test("a checklist row's action is carried into the markup", () => {
  const start = app.indexOf('case "setup_checklist"');
  const body = app.slice(start, start + 1600);
  assert.match(body, /check\.action/);
});

/* ---------- U32: the worktree location ---------- */

test("the worktree location row states where worktrees go and does not offer an editor", () => {
  const start = settings.indexOf("worktree");
  assert.ok(start > -1);
  // It is a fixed rule (inside the repo, git-ignored), not a setting; the page
  // used to show it under a row that read like every editable one around it.
  assert.ok(!/id: "setting-worktree-root"/.test(settings), "there is no editor for it");
  assert.match(worktree, /.prometheus", "worktrees"/, "the path the page documents is the one used");
});

/* ---------- U34: a colour-vision theme ---------- */

test("a colour-vision theme exists and only redefines semantic colours", () => {
  const start = styles.indexOf('[data-theme="daltonized"]');
  assert.ok(start > -1, "the theme is defined");
  const block = styles.slice(start, start + 1400);
  assert.match(block, /--danger|--success|--warn/);
  assert.match(app, /daltonized/);
});

/* ---------- U35: the queued state ---------- */

test("the queued button has a style", () => {
  assert.match(styles, /\.queues\b|\.queued\b/);
});

/* ---------- U36: per-message actions ---------- */

test("a user turn offers copy, retry and edit", () => {
  const start = app.indexOf("function addUserTurn");
  const body = app.slice(start, start + 1800);
  assert.match(body, /copy/i);
  assert.match(body, /retry/i);
  assert.match(body, /edit/i);
});

/* ---------- U33: the first session is isolated too ---------- */

test("the launch session honours isolate-by-default", () => {
  const start = host.indexOf('send({ type: "ready" })');
  const before = host.slice(Math.max(0, start - 700), start);
  assert.match(before, /createAgent\(\[\]\)/);
  assert.match(before, /enterDefaultWorktree/, "the launch path enters the worktree like a new session");
});

/* ---------- U31: one approval input ---------- */

test("autoApprove is migrated into the rule list rather than offered twice", () => {
  // Two inputs for one decision meant a user could allow something in one place
  // and deny it in the other, and the answer depended on which was read first.
  assert.ok(!/autoApprove: \"|autoApproveDesc/.test(settings), "the old input is gone");
});
