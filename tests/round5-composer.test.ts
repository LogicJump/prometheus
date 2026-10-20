/**
 * The composer's bottom row: six modes reachable, a "+" that adds things, and
 * an effort menu built from the model's own levels.
 *
 * These are structural assertions on the shipped files. They exist because the
 * defects they describe are invisible to the TypeScript compiler and to any
 * test that does not open the window: a mode that only exists in the command
 * palette, a menu whose rows are hard-coded for a model that does not accept
 * them, and a settings select that offers three of the runtime's six modes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("desktop/renderer/index.html", "utf8");
const app = readFileSync("desktop/renderer/app.js", "utf8");
const settings = readFileSync("desktop/renderer/settings.js", "utf8");
const host = readFileSync("desktop/host.js", "utf8");
const css = readFileSync("desktop/renderer/styles.css", "utf8");
const i18n = readFileSync("desktop/renderer/i18n.js", "utf8");

test("every permission mode is in the menu, not only the three the rail had", () => {
  // The rail carried ask/auto/plan; acceptEdits, dontAsk and bypassPermissions
  // existed in the runtime and were reachable only from the command palette.
  const modes = /const MODES = \[([^\]]+)\]/.exec(app)?.[1] ?? "";
  for (const mode of ["ask", "auto", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]) {
    assert.ok(modes.includes(`"${mode}"`), `${mode} is missing from the mode menu`);
  }
  // And the settings dialog agrees with the runtime.
  for (const mode of ["acceptEdits", "dontAsk", "bypassPermissions"]) {
    assert.ok(settings.includes(`value: "${mode}"`), `${mode} is missing from the settings select`);
    assert.ok(host.includes(`"${mode}"`), `${mode} would be dropped when saved from settings`);
  }
});

test("the mode menu opens upward, like every other composer menu", () => {
  const menu = /\.mode-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(menu, /bottom:\s*calc\(100% \+ 6px\)/, "a menu under the composer must open upward");
  assert.match(menu, /position:\s*absolute/);
});

test("the + menu offers files, a folder and slash commands", () => {
  for (const id of ["plus-add-files", "plus-add-folder", "plus-slash"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from the menu`);
    assert.ok(app.includes(`$("${id}")`), `${id} has no handler`);
  }
  // The file dialog is the multi-select one; a single path would defeat "files".
  assert.match(app, /api\.pickFile\(\{\s*multiple:\s*true\s*\}\)/);
});

test("the effort menu is rendered from the model's advertised levels", () => {
  assert.match(app, /function effortLevels\(\)/);
  assert.match(app, /state\.effortChoices\?\.levels/);
  assert.match(app, /function renderEffortMenu\(\)/);
  // The old markup had four hard-coded rows; they are gone, or a model without
  // `medium` would still offer it.
  assert.ok(!/data-effort="medium" data-i18n/.test(html), "hard-coded effort rows must be gone");
  // A model that reasons at a fixed level says so instead of offering a choice.
  assert.match(app, /effortFixed/);
  // The host supplies the list, and the state event carries it.
  assert.match(host, /effortChoices: effortChoices\(\)/);
  assert.match(host, /reasoningEfforts/);
});

test("auto sends no level; every other level goes on the wire unchanged", () => {
  const llm = readFileSync("src/llm.ts", "utf8");
  assert.match(llm, /if \(effort && effort !== "auto"\) body\.reasoning_effort = effort;/);
  // No translation table: `xhigh` and `max` are the gateway's spellings.
  assert.ok(!/reasoning_effort\s*=\s*\{[\s\S]{0,200}high max/.test(llm));
});

test("the bottom row puts the model, its window and the level on the right", () => {
  assert.match(html, /controls-right/);
  assert.match(css, /\.composer-bar \.controls-right\s*\{[^}]*margin-left:\s*auto/);
  // The context chip shows the window size, which a bare percentage did not.
  assert.match(html, /id="context-length"/);
  assert.match(app, /function renderContextLength\(\)/);
});

test("the context popover breaks the window down by kind", () => {
  for (const id of ["usage-stack", "usage-breakdown"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing`);
  }
  assert.match(app, /function renderUsage\(\)/);
  assert.match(app, /contextPart\(part\.key\)/);
  // Both locales name every category, or one language shows raw keys.
  for (const key of ["messages", "toolResults", "mcpTools", "systemTools", "memory", "instructions"]) {
    assert.ok(i18n.includes(`${key}:`), `${key} has no label`);
  }
  assert.match(host, /contextBreakdown: agent \? agent\.contextBreakdown\(\) : null/);
});

test("the progress line shows output tokens and no status sentence", () => {
  assert.match(app, /progress\.outputTokens/);
  assert.ok(!/progressServerQuiet|progressWaiting|progressStreaming/.test(app + i18n));
  // Input tokens are the prompt the user already sent; adding them to the live
  // count made the number jump by six figures on the first heartbeat.
  assert.ok(!/tokens:\s*usage\.inputTokens \+ usage\.outputTokens/.test(host));
});
