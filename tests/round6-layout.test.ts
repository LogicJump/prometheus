/**
 * The three-column layout at its default window size.
 *
 * Opening the inspector used to make the composer taller than the pane it sat
 * in: the bar carried `flex-wrap: wrap`, and the inspector took 46% of the
 * *remaining* width rather than of the window, so the conversation was left
 * with 548 px and the model/effort chips wrapped to a second row. The tab
 * strip wrapped to two rows for the same reason, and the session/last-turn
 * switch competed with it for the same 400 px.
 *
 * These assertions are on the shipped files rather than on a rendered window:
 * the values are what decides the layout, and a headless test can check them
 * without an Electron process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("desktop/renderer/styles.css", "utf8");
const html = readFileSync("desktop/renderer/index.html", "utf8");

/**
 * The first declaration block for a selector.
 *
 * The last one is usually a responsive override (`@media` or a narrow-window
 * rule), which by design says something different from the base layout.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.\\[\]()+*?^$|{}]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : "";
}

test("the inspector has a fixed width, not a share of what is left", () => {
  const workbench = rule(".workbench");
  assert.match(workbench, /width:\s*\d+px/, "a percentage of the remaining row squeezed the conversation");
  assert.ok(!/width:\s*46%/.test(workbench));
  // A floor and a ceiling, so a narrow window still shows the pane and a wide
  // one does not let it eat the conversation.
  assert.match(workbench, /min-width:\s*\d+px/);
  assert.match(workbench, /max-width:\s*\d+px/);
});

test("the composer bar never wraps", () => {
  const bar = rule(".composer-bar");
  assert.match(bar, /flex-wrap:\s*nowrap/);
  // The right-hand group has to be able to shrink, or nowrap just overflows.
  const right = rule(".composer-bar .controls-right");
  assert.match(right, /overflow:\s*hidden/);
  assert.match(right, /min-width:\s*0/);
});

test("the pane tabs scroll in one row instead of wrapping", () => {
  const tabs = rule(".workbench-tabs");
  assert.match(tabs, /flex-wrap:\s*nowrap/);
  assert.match(tabs, /overflow-x:\s*auto/);
  // And they are given the head's width rather than whatever the switch and
  // the meta text leave behind.
  assert.match(tabs, /flex:\s*1 1 auto/);
});

test("the diff scope switch shares the git bar's row", () => {
  // A row of its own cost 33 px of an 834 px pane and left nine tabs 193 px.
  const gitBar = html.slice(html.indexOf('id="git-bar"'), html.indexOf('id="pr-bar"') >= 0 ? html.indexOf('id="pr-bar"') : undefined);
  assert.ok(gitBar.includes('id="diff-scope"'), "the switch belongs inside the git bar");
  const scope = rule(".diff-scope");
  assert.match(scope, /margin-left:\s*auto/);
});
