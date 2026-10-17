/** Slash-command discovery and expansion. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandCommand, expandSlash, listCommands } from "../src/commands.ts";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-cmd-"));
  const commands = join(dir, ".prometheus", "commands");
  mkdirSync(commands, { recursive: true });
  writeFileSync(
    join(commands, "review.md"),
    "---\ndescription: Review the current diff\nargument-hint: [path]\n---\nReview the changes in $ARGUMENTS.\n",
    "utf8",
  );
  writeFileSync(join(commands, "summary.md"), "Summarize this project.\n", "utf8");
  writeFileSync(join(commands, "notes.txt"), "not a command", "utf8");
  return dir;
}

test("commands are read from the project directory with frontmatter parsed", () => {
  const dir = workspace();
  try {
    const commands = listCommands(dir);
    const review = commands.find((command) => command.name === "review");
    assert.ok(review);
    assert.equal(review.description, "Review the current diff");
    assert.equal(review.argumentHint, "[path]");
    assert.equal(review.body, "Review the changes in $ARGUMENTS.");
    assert.ok(commands.some((command) => command.name === "summary"));
    assert.ok(!commands.some((command) => command.name === "notes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("$ARGUMENTS is substituted, and appended when absent", () => {
  const dir = workspace();
  try {
    const [review, summary] = ["review", "summary"].map((name) => listCommands(dir).find((c) => c.name === name));
    assert.equal(expandCommand(review, "src/app.ts"), "Review the changes in src/app.ts.");
    assert.equal(expandCommand(summary, "src/app.ts"), "Summarize this project.\n\nsrc/app.ts");
    assert.equal(expandCommand(summary, "  "), "Summarize this project.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only known commands expand; other slashes pass through", () => {
  const dir = workspace();
  try {
    const expanded = expandSlash(dir, "/review src/diff.ts");
    assert.equal(expanded.command.name, "review");
    assert.equal(expanded.prompt, "Review the changes in src/diff.ts.");
    assert.equal(expandSlash(dir, "/unknown do a thing"), null);
    assert.equal(expandSlash(dir, "hello"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
