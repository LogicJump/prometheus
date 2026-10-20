/**
 * The composer's "/" menu: the built-ins have to be in the list it reads.
 *
 * `listCommands` returned only markdown files from `commands/`, so a user who
 * had never written one typed "/" and saw nothing at all — while the commands
 * themselves existed in the CLI and in the command palette. The menu also
 * could not be seen when it did have rows: it was absolutely positioned
 * against the composer's top edge, which sits at the bottom of the window, so
 * it rendered above the viewport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "prometheus-menu-"));
process.env.PROMETHEUS_HOME = home;
const { listCommands, findCommand, isBuiltinCommand, BUILTIN_COMMANDS } = await import("../src/commands.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-menu-ws-"));
  mkdirSync(join(dir, ".prometheus", "commands"), { recursive: true });
  return dir;
}

test("an empty workspace still lists the built-in commands", () => {
  const dir = workspace();
  try {
    const commands = listCommands(dir);
    assert.ok(commands.length >= 10, `expected the built-ins, got ${commands.length}`);
    for (const name of ["clear", "compact", "context", "model", "mode", "effort"]) {
      assert.ok(commands.some((command) => command.name === name), `/${name} is missing from the menu`);
    }
    // They are marked, so the renderer can run them on click instead of
    // inserting text that needs a second Enter.
    assert.ok(commands.filter((command) => command.source === "builtin").length === BUILTIN_COMMANDS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a markdown file replaces a built-in of the same name instead of duplicating it", () => {
  const dir = workspace();
  try {
    writeFileSync(join(dir, ".prometheus", "commands", "compact.md"), "Compact with my own wording.\n", "utf8");
    const matches = listCommands(dir).filter((command) => command.name === "compact");
    assert.equal(matches.length, 1, "a name appears once");
    assert.equal(matches[0].source, "project/compact.md", "the project's file wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a built-in is never expanded into a prompt", () => {
  // A built-in carries an empty body; expanding it would send an empty message.
  assert.equal(isBuiltinCommand("/clear"), true);
  assert.equal(isBuiltinCommand("clear"), true);
  assert.equal(isBuiltinCommand("review"), false);
  const dir = workspace();
  try {
    assert.equal(findCommand(dir, "clear"), null);
    assert.equal(findCommand(dir, "review"), null, "an unknown name is still null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the menu is positioned inside the viewport", () => {
  // The composer is the positioning context and sits at the bottom of the
  // window; `left: 0; right: 0` against it produced a menu above the top edge.
  const css = readFileSync("desktop/renderer/styles.css", "utf8");
  const menu = /\.command-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(menu, /bottom:\s*calc\(100% \+ 6px\)/);
  assert.match(menu, /left:\s*10px/, "the menu must not span the whole composer");
  assert.match(menu, /max-height:/, "a long list scrolls rather than overflowing");
});

test("the host runs a built-in instead of sending it to the model", () => {
  const host = readFileSync("desktop/host.js", "utf8");
  // `prompt` has to check the built-in table before the prompt-expansion path.
  const prompt = host.slice(host.indexOf('case "prompt":'), host.indexOf('case "listCommands":'));
  assert.match(prompt, /runBuiltinSlash\(/, "a built-in typed in the composer would reach the model as literal text");
  for (const name of ["clear", "compact", "context", "export", "model", "mode", "effort"]) {
    assert.match(host, new RegExp(`case "${name}":`), `/${name} has no implementation`);
  }
});
