/** Rewind: checkpoints know which message they belong to, and files roll back by that index. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureBefore, clearCheckpoints, loadCheckpoints, restoreAfterMessage } from "../src/checkpoints.ts";
import { newSessionId } from "../src/sessions.ts";

function workspace(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-rewind-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

test("a checkpoint records the conversation length it belongs to", () => {
  const session = newSessionId();
  const dir = workspace({ "a.txt": "v1" });
  try {
    const entry = captureBefore(session, "edit_file", dir, "a.txt", 5);
    assert.equal(entry?.messageIndex, 5);
    assert.equal(loadCheckpoints(session).entries[0].messageIndex, 5);
  } finally {
    clearCheckpoints(session);
  }
});

test("rewinding to a message restores files changed at or after it", () => {
  const session = newSessionId();
  const dir = workspace({ "a.txt": "v1", "b.txt": "keep" });
  try {
    // Turn one (message index 1) edits a.txt.
    captureBefore(session, "edit_file", dir, "a.txt", 1);
    writeFileSync(join(dir, "a.txt"), "v2", "utf8");
    // Turn two (message index 6) edits a.txt again and creates c.txt.
    captureBefore(session, "edit_file", dir, "a.txt", 6);
    writeFileSync(join(dir, "a.txt"), "v3", "utf8");
    captureBefore(session, "write_file", dir, "c.txt", 6);
    writeFileSync(join(dir, "c.txt"), "new", "utf8");
    // An unrelated later edit that must also be undone by the rewind point.
    captureBefore(session, "edit_file", dir, "b.txt", 9);
    writeFileSync(join(dir, "b.txt"), "changed", "utf8");

    const result = restoreAfterMessage(session, 6);
    assert.deepEqual(result.errors, []);
    assert.equal(result.affected, 3, "second a.txt edit, c.txt create, and the b.txt edit");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v2", "turn two is undone, turn one stays");
    assert.equal(existsSync(join(dir, "c.txt")), false, "a file created after the point is removed");
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "keep", "later changes are undone too");
    // Checkpoints before the point remain usable.
    assert.equal(loadCheckpoints(session).entries.length, 1);
    assert.equal(loadCheckpoints(session).entries[0].messageIndex, 1);
  } finally {
    clearCheckpoints(session);
  }
});

test("rewinding to the first message clears every checkpoint", () => {
  const session = newSessionId();
  const dir = workspace({ "a.txt": "original" });
  try {
    captureBefore(session, "edit_file", dir, "a.txt", 1);
    writeFileSync(join(dir, "a.txt"), "changed", "utf8");
    captureBefore(session, "edit_file", dir, "a.txt", 3);
    writeFileSync(join(dir, "a.txt"), "twice", "utf8");

    const result = restoreAfterMessage(session, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "original");
    assert.equal(loadCheckpoints(session).entries.length, 0);
  } finally {
    clearCheckpoints(session);
  }
});

test("rewinding past every checkpoint changes nothing", () => {
  const session = newSessionId();
  const dir = workspace({ "a.txt": "x" });
  try {
    captureBefore(session, "edit_file", dir, "a.txt", 2);
    writeFileSync(join(dir, "a.txt"), "y", "utf8");
    const result = restoreAfterMessage(session, 99);
    assert.equal(result.affected, 0);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "y");
  } finally {
    clearCheckpoints(session);
  }
});

test("checkpoints written before message indexes existed are left alone", () => {
  const session = newSessionId();
  const dir = workspace({ "old.txt": "legacy" });
  try {
    captureBefore(session, "edit_file", dir, "old.txt"); // no message index
    writeFileSync(join(dir, "old.txt"), "changed", "utf8");
    const result = restoreAfterMessage(session, 1);
    assert.equal(result.affected, 0);
    assert.equal(readFileSync(join(dir, "old.txt"), "utf8"), "changed");
  } finally {
    clearCheckpoints(session);
  }
});
