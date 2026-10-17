/** Git status parsing and commit plumbing against a temporary repository. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitCommit, gitStatus, parseStatus } from "../desktop/git.js";

test("porcelain status maps codes to readable states", () => {
  const entries = parseStatus(" M src/a.ts\0?? notes.txt\0A  added.txt\0D  gone.txt\0R  new.ts\0old.ts\0");
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.status]),
    [
      ["src/a.ts", "modified"],
      ["notes.txt", "untracked"],
      ["added.txt", "added"],
      ["gone.txt", "deleted"],
      ["old.ts -> new.ts", "renamed"],
    ],
  );
});

test("a non-repository reports itself as unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-nogit-"));
  try {
    const status = await gitStatus(dir);
    assert.equal(status.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status and commit work in a real repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-git-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "one\n", "utf8");

    const before = await gitStatus(dir);
    assert.equal(before.available, true);
    assert.equal(before.clean, false);
    assert.equal(before.files[0].status, "untracked");

    const committed = await gitCommit(dir, "first commit");
    assert.equal(committed.ok, true, committed.error);
    assert.match(committed.summary, /first commit/);

    const after = await gitStatus(dir);
    assert.equal(after.clean, true);
    assert.equal(typeof after.branch, "string");
    assert.ok(after.branch.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty commit message is refused without touching the index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-git2-"));
  try {
    const result = await gitCommit(dir, "   ");
    assert.equal(result.ok, false);
    assert.match(result.error, /message/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
