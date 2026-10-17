/** Hooks: configuration parsing, matching, and blocking behavior. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hooksFor, loadHooks, runHooks } from "../src/hooks.ts";

function workspace(hooks: object) {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-hooks-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(join(dir, ".prometheus", "hooks.json"), JSON.stringify({ hooks }), "utf8");
  return dir;
}

test("hooks are loaded per event and matchers select tools", () => {
  const dir = workspace({
    PreToolUse: [{ matcher: "^bash$", command: "exit 0" }, { command: "exit 0" }],
    Stop: [{ command: "exit 0" }],
  });
  try {
    const hooks = loadHooks(dir);
    assert.equal(hooks.length, 3);
    assert.equal(hooksFor(hooks, "PreToolUse", "bash").length, 2);
    assert.equal(hooksFor(hooks, "PreToolUse", "read_file").length, 1);
    assert.equal(hooksFor(hooks, "Stop", "bash").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing PreToolUse hook blocks and carries its reason", async () => {
  // `;` is a separator in sh but not in cmd; each shell needs its own form.
  const command = process.platform === "win32" ? "echo no writes today & exit 3" : "echo no writes today; exit 3";
  const dir = workspace({ PreToolUse: [{ command }] });
  try {
    const hooks = loadHooks(dir);
    const results = await runHooks(hooksFor(hooks, "PreToolUse", "bash"), "PreToolUse", { tool: "bash" }, dir);
    assert.equal(results.length, 1);
    assert.equal(results[0].blocked, true);
    assert.equal(results[0].code, 3);
    assert.match(results[0].output, /no writes today/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a passing PostToolUse hook does not block", async () => {
  const dir = workspace({ PostToolUse: [{ command: "echo checked" }] });
  try {
    const hooks = loadHooks(dir);
    const results = await runHooks(hooksFor(hooks, "PostToolUse", "edit_file"), "PostToolUse", { tool: "edit_file" }, dir);
    assert.equal(results[0].blocked, false);
    assert.equal(results[0].code, 0);
    assert.match(results[0].output, /checked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks receive the event payload on stdin", async () => {
  const dir = workspace({
    PreToolUse: [
      process.platform === "win32"
        ? { command: "findstr tool", timeout_ms: 10000 }
        : { command: "grep -q '\"tool\":\"bash\"' && exit 0 || exit 9" },
    ],
  });
  try {
    const hooks = loadHooks(dir);
    const results = await runHooks(hooksFor(hooks, "PreToolUse", "bash"), "PreToolUse", { tool: "bash", input: {} }, dir);
    assert.equal(results[0].code, 0, results[0].output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
