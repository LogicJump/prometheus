/** Artifact discovery and CSV parsing. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactCandidates, artifactKind, collectArtifacts, parseCsv, readArtifact } from "../src/artifacts.ts";

test("only previewable extensions are artifacts", () => {
  assert.equal(artifactKind("report.md"), "markdown");
  assert.equal(artifactKind("page.HTML"), "html");
  assert.equal(artifactKind("data.csv"), "csv");
  assert.equal(artifactKind("app.ts"), null);
});

test("collectArtifacts keeps touched, recent, previewable files", () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-art-"));
  try {
    writeFileSync(join(dir, "report.md"), "# hi\n", "utf8");
    writeFileSync(join(dir, "notes.txt"), "plain\n", "utf8");
    const since = new Date(Date.now() - 60_000).toISOString();
    const found = collectArtifacts(dir, ["report.md", "notes.txt", "missing.md"], since);
    assert.deepEqual(found.map((artifact) => artifact.path), ["report.md"]);
    assert.equal(found[0].kind, "markdown");
    const old = collectArtifacts(dir, ["report.md"], new Date(Date.now() + 60_000).toISOString());
    assert.equal(old.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifactCandidates walks directories and skips build folders", () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-art2-"));
  try {
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "docs", "a.md"), "x", "utf8");
    writeFileSync(join(dir, "node_modules", "b.md"), "x", "utf8");
    const found = artifactCandidates(dir).map((path) => path.split("\\").join("/"));
    assert.ok(found.some((path) => path.endsWith("docs/a.md")));
    assert.ok(!found.some((path) => path.includes("node_modules")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading an artifact rejects paths outside the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-art3-"));
  try {
    writeFileSync(join(dir, "a.md"), "ok", "utf8");
    assert.equal(readArtifact(dir, "a.md").content, "ok");
    assert.throws(() => readArtifact(dir, "../secret.md"), /escapes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSV parsing handles quotes, embedded commas, and CRLF", () => {
  const rows = parseCsv('name,note\r\n"Smith, J","said ""hi"""\r\nplain,x\r\n');
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Smith, J", 'said "hi"'],
    ["plain", "x"],
  ]);
});
