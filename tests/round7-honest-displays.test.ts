/**
 * Two displays that reported something the system had not actually observed.
 *
 * Neither was broken code. Both were fields with a value in them that nothing
 * had measured: the profile block said "Not signed in" in a product with no
 * accounts, and the context meter drew a percentage of a hard-coded 1,000,000
 * that no endpoint had reported. A number on screen is a claim, and these were
 * claims with nothing behind them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("desktop/renderer/index.html", "utf8");
const settings = readFileSync("desktop/renderer/settings.js", "utf8");
const app = readFileSync("desktop/renderer/app.js", "utf8");

test("the settings profile block does not claim a sign-in state", () => {
  // There is no account system, so "Not signed in" described a state that
  // cannot exist, and the button under it was never wired to anything.
  assert.ok(!/Not signed in/.test(html), "the product has no accounts to be signed out of");
  assert.ok(!/>Not signed in</.test(settings));
});

test("the settings profile block does something when clicked", () => {
  assert.match(settings, /\$\("settings-profile"\)\.addEventListener\("click"/);
});

test("the context window field is empty until a value is configured", () => {
  // `value: settings.contextWindow ?? 1000000` put a number in the field that
  // read as the model's window even when nothing had stated one.
  assert.ok(!/contextWindow \?\? 1000000/.test(settings), "a default must not be presented as a configured value");
  const contextRow = settings.slice(settings.indexOf('id: "setting-context"'));
  assert.match(contextRow.slice(0, 600), /value: settings\.contextWindow \?\? ""/);
});

test("the usage meter marks a window it only assumed", () => {
  assert.match(app, /info\.windowAssumed/);
  assert.match(app, /usageWindowAssumed/);
});
