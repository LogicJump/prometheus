/**
 * Round 9, batch 8: the cleanup list.
 *
 * Nothing here changes what a user can do, except where a stale claim was
 * removed. The tests are structural on purpose: the entries are about files
 * that lie (a comment claiming coverage that does not exist), strings nothing
 * reads, and protocol fields one side sends and the other drops.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { splitClamp } from "../desktop/windowBounds.js";
import { logLevelOf } from "../src/embedded/serial.ts";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const i18n = readFileSync("desktop/renderer/i18n.js", "utf8");
const settingsI18n = readFileSync("desktop/renderer/settings-i18n.js", "utf8");
const host = readFileSync("desktop/host.js", "utf8");
const agent = readFileSync("src/agent.ts", "utf8");
const styles = readFileSync("desktop/renderer/styles.css", "utf8");
const main = readFileSync("desktop/main.js", "utf8");

/* ---------- U38: a duplicate key ---------- */

test("askMultiHint appears once per locale and the English block is English", () => {
  const count = (i18n.match(/^\s+askMultiHint:/gm) ?? []).length;
  assert.equal(count, 2, "one per locale");
  const en = i18n.slice(i18n.indexOf("en:"), i18n.indexOf("zh:"));
  const zh = i18n.slice(i18n.indexOf("zh:"));
  assert.equal((en.match(/askMultiHint:/g) ?? []).length, 1);
  assert.equal((zh.match(/askMultiHint:/g) ?? []).length, 1);
  assert.match(zh, /askMultiHint: "可以多选。"/);
});

/* ---------- U39: functions nothing calls ---------- */

test("renderTree and openBrowserPane are gone or wired", () => {
  for (const name of ["renderTree", "openBrowserPane"]) {
    const uses = (app.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
    assert.ok(uses !== 1, `${name} is still a definition with no caller`);
  }
});

/* ---------- U40: copy describing a removed input ---------- */

test("the settings dictionary no longer describes a comma-separated box", () => {
  assert.ok(!/autoApproveDesc/.test(settingsI18n), "the description of the removed input is gone");
  assert.ok(!/autoApproveRulesHint/.test(settingsI18n), "and its hint");
});

/* ---------- U41: fields sent and never read ---------- */

test("turn_progress only sends what the progress line reads", () => {
  const sent = host.slice(host.indexOf('send({', host.indexOf("heartbeat()")), host.indexOf("});", host.indexOf("heartbeat()")));
  assert.ok(!/turns:/.test(sent), "`turns` is either rendered or not sent");
});

test("progress.retry is rendered or not assigned", () => {
  const assigned = /progress\.retry\s*=/.test(app);
  const read = /progress\.retry\b(?!\s*=)/.test(app);
  assert.ok(!assigned || read, "an assigned value is read somewhere");
});

/* ---------- U42: clearing the agent's ring ---------- */

test("clearing the pane clears the ring the agent reads", () => {
  const start = host.indexOf('case "serialClear"');
  assert.ok(start > -1);
  const body = host.slice(start, start + 700);
  assert.match(body, /clearRecentLines/);
});

/* ---------- U43: the baud select writes the selection ---------- */

test("changing the baud rate is remembered", () => {
  const start = app.indexOf('$("serial-baud").addEventListener');
  assert.ok(start > -1, "there is a listener");
  const body = app.slice(start, start + 500);
  assert.match(body, /saveBoardSelection|serial\.baud/);
});

/* ---------- U44: generic log levels ---------- */

test("plain WARN and ERROR prefixes are recognised as levels", () => {
  assert.equal(logLevelOf("WARN: retrying"), "warn");
  assert.equal(logLevelOf("[WARN] low heap"), "warn");
  assert.equal(logLevelOf("ERROR: i2c timeout"), "error");
  assert.equal(logLevelOf("[ERROR] boom"), "error");
  // ESP-IDF's `E (123) tag: msg` is parsed by the structured format, not here.
  assert.equal(logLevelOf("<inf> net: connected"), null);
  assert.equal(logLevelOf("just some output"), null);
});

/* ---------- U46/U47: test coverage claims ---------- */

/* ---------- U51: the split window fits the display ---------- */

test("a split window is clamped to the work area of its display", () => {
  const view = splitClamp({ x: 1900, y: 40, width: 1200, height: 800 }, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.ok(view.x + view.width <= 1920, "not past the right edge");
  assert.ok(view.y >= 0 && view.y + view.height <= 1080, "inside vertically");
});

test("a window that already fits is left alone", () => {
  const bounds = { x: 100, y: 80, width: 1000, height: 700 };
  assert.deepEqual(splitClamp(bounds, { x: 0, y: 0, width: 1920, height: 1080 }), bounds);
});

/* ---------- U52: OpenOCD and J-Link take part in identification ---------- */

test("the identification call receives the OpenOCD target when one is configured", () => {
  const start = host.indexOf("identifyAttached(");
  const body = host.slice(start - 800, start + 200);
  assert.match(body, /openocdTarget|target_config|openocd/);
});

/* ---------- U49/U50: large diffs ---------- */

test("a large pending diff can be expanded", () => {
  const start = app.indexOf("function renderPendingDiff");
  assert.ok(start > -1, "the function exists");
  const body = app.slice(start, start + 3200);
  assert.match(body, /expanded = false/, "the preview takes an expanded flag");
  assert.match(body, /pendingDiffShowAll|showAll/, "and offers a control that sets it");
});

test("diff text can scroll horizontally instead of being squeezed", () => {
  // `.diff-text` appears several times; the base rule is the one without a
  // parent selector.
  const start = styles.search(/\n\.diff-text \{/);
  assert.ok(start > -1);
  const rule = styles.slice(start, styles.indexOf("}", start));
  assert.match(rule, /min-width:\s*max-content|overflow-x/);
});

/* ---------- files exist ---------- */

test("the modules the plan names exist", () => {
  for (const path of ["desktop/sessionView.js", "desktop/renderer/boardView.js", "src/titlePolicy.ts"]) {
    assert.ok(existsSync(path), path);
  }
});

/* ---------- U52: the J-Link reader ---------- */

test("a J-Link memory read is parsed by its address", async () => {
  const { parseJlinkRead32 } = await import("../src/embedded/identity.ts");
  assert.equal(parseJlinkRead32("E0042000 = 20036419\n", 0xe0042000), 0x20036419);
  assert.equal(parseJlinkRead32("E0041000 = 20036419\n", 0xe0042000), undefined);
});
