/** Worktree isolation: create, diff, merge, and removal against a real repo. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitWorktree,
  createWorktree,
  isRepository,
  mergeWorktree,
  removeWorktree,
  worktreeDiff,
} from "../src/worktree.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-wt-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  run("add", "-A");
  run("commit", "-m", "initial");
  return dir;
}

test("a non-repository is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-wt-no-"));
  try {
    assert.equal(await isRepository(dir), false);
    const result = await createWorktree(dir, "s1");
    assert.equal(result.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree isolates edits, then merges back and is removed", async () => {
  const dir = repo();
  try {
    const created = await createWorktree(dir, "session-a");
    assert.equal(created.ok, true, created.error);
    const worktree = created.worktree;
    assert.ok(existsSync(worktree.path));

    writeFileSync(join(worktree.path, "a.txt"), "two\n", "utf8");
    writeFileSync(join(worktree.path, "b.txt"), "new\n", "utf8");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n", "the main checkout is untouched");

    const diff = await worktreeDiff(worktree);
    assert.match(diff, /two/);
    assert.match(diff, /\?\? b\.txt/);

    const committed = await commitWorktree(worktree, "worktree change");
    assert.equal(committed.ok, true, committed.error);

    const merged = await mergeWorktree(dir, worktree);
    assert.equal(merged.ok, true, merged.error);
    // git's autocrlf converts the checkout on Windows.
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "two\n");
    assert.ok(existsSync(join(dir, "b.txt")));

    const removed = await removeWorktree(dir, worktree);
    assert.equal(removed.ok, true);
    assert.equal(existsSync(worktree.path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository with no commits still gets a usable worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-wt-empty-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "readme.md"), "hello\n", "utf8");
    const created = await createWorktree(dir, "session-b");
    assert.equal(created.ok, true, created.error);
    assert.ok(existsSync(join(created.worktree.path, "readme.md")));
    await removeWorktree(dir, created.worktree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("creating the same session twice reuses its worktree", async () => {
  const dir = repo();
  try {
    const first = await createWorktree(dir, "session-c");
    const second = await createWorktree(dir, "session-c");
    assert.equal(first.ok && second.ok, true);
    assert.equal(first.worktree.path, second.worktree.path);
    await removeWorktree(dir, first.worktree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
