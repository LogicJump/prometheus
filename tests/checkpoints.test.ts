/** Checkpoint capture and restore, against a temporary workspace. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureBefore, loadCheckpoints, restoreTo, clearCheckpoints } from "../src/checkpoints.ts";

test("checkpoints restore a modified file and remove a created one", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-cp-"));
  const session = `test-${Date.now()}`;
  const target = join(workspace, "notes.txt");
  writeFileSync(target, "original\n", "utf8");

  try {
    // First mutation: modify an existing file.
    captureBefore(session, "edit_file", workspace, "notes.txt");
    writeFileSync(target, "changed\n", "utf8");

    // Second mutation: create a new file.
    const second = "created.txt";
    captureBefore(session, "write_file", workspace, second);
    writeFileSync(join(workspace, second), "fresh\n", "utf8");

    const state = loadCheckpoints(session);
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries[0].kind, "modified");
    assert.equal(state.entries[1].kind, "created");

    const result = restoreTo(session, "start");
    assert.equal(result.errors.length, 0);
    assert.equal(readFileSync(target, "utf8"), "original\n");
    assert.equal(existsSync(join(workspace, second)), false);
    assert.equal(loadCheckpoints(session).entries.length, 0);
  } finally {
    clearCheckpoints(session);
  }
});

test("restoring to a midpoint keeps earlier edits", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-cp2-"));
  const session = `test-${Date.now()}-mid`;
  const file = join(workspace, "log.txt");
  writeFileSync(file, "v0\n", "utf8");

  try {
    captureBefore(session, "edit_file", workspace, "log.txt");
    writeFileSync(file, "v1\n", "utf8");
    const first = loadCheckpoints(session).entries[0];

    captureBefore(session, "edit_file", workspace, "log.txt");
    writeFileSync(file, "v2\n", "utf8");

    const result = restoreTo(session, first.id);
    assert.equal(result.errors.length, 0);
    // Restoring to the first checkpoint puts the file back to its v0 state.
    assert.equal(readFileSync(file, "utf8"), "v0\n");
  } finally {
    clearCheckpoints(session);
  }
});

test("nested directories are recreated on restore", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-cp3-"));
  const session = `test-${Date.now()}-dir`;
  const nested = join(workspace, "deep", "inside");
  mkdirSync(nested, { recursive: true });
  const file = join(nested, "a.txt");
  writeFileSync(file, "before\n", "utf8");

  try {
    captureBefore(session, "edit_file", workspace, "deep/inside/a.txt");
    writeFileSync(file, "after\n", "utf8");
    restoreTo(session, "start");
    assert.equal(readFileSync(file, "utf8"), "before\n");
  } finally {
    clearCheckpoints(session);
  }
});
