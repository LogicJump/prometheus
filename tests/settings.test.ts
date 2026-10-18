/** Settings-backed files: usage accounting, MCP entries, skills, instructions. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { usageSummary } from "../src/usage.ts";
import { listSkills, saveSkill, removeSkill, listMcpServers, saveMcpServer, removeMcpServer } from "../src/settingsFiles.ts";

// usage.ts and settingsFiles.ts write under CONFIG_HOME, which is fixed at
// import time; the tests therefore inspect the pure summary logic through the
// public API and use a temp workspace for the file-shaped ones.

test("usage summary covers the requested window with contiguous days", () => {
  const summary = usageSummary(7);
  assert.equal(summary.days.length, 7);
  // Days are ascending and end today.
  const today = new Date();
  const key = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  assert.equal(summary.days[6].date, key(today));
  for (let index = 1; index < summary.days.length; index++) {
    assert.ok(summary.days[index].date > summary.days[index - 1].date);
  }
  assert.ok(summary.totals.turns >= 0);
});

test("a skill round-trips through its file, frontmatter and all", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-skills-"));
  saveSkill(cwd, {
    name: "review",
    description: "Review the current diff",
    argumentHint: "[path]",
    scope: "project",
    body: "Review $ARGUMENTS and list anything risky.",
  });
  const file = join(cwd, ".prometheus", "commands", "review.md");
  assert.ok(existsSync(file));
  const text = readFileSync(file, "utf8");
  assert.match(text, /^---\n/);
  assert.match(text, /description: Review the current diff/);
  assert.match(text, /argument-hint: \[path\]/);

  const listed = listSkills(cwd).filter((skill) => skill.scope === "project");
  const review = listed.find((skill) => skill.name === "review");
  assert.ok(review);
  assert.equal(review.description, "Review the current diff");
  assert.equal(review.argumentHint, "[path]");
  assert.match(review.body, /\$ARGUMENTS/);

  removeSkill(cwd, "project", "review");
  assert.equal(existsSync(file), false);
});

test("an invalid skill name is rejected rather than written", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-skills-bad-"));
  assert.throws(() =>
    saveSkill(cwd, { name: "Not A Name", description: "", argumentHint: "", scope: "project", body: "x" }),
  );
});

test("MCP entries keep their shape and scope, and removal is local", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-mcp-"));
  mkdirSync(join(cwd, ".prometheus"), { recursive: true });
  saveMcpServer(cwd, { name: "files", scope: "project", command: "npx", args: ["-y", "server-filesystem"] });
  const file = join(cwd, ".prometheus", "mcp.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(parsed.servers.files.args, ["-y", "server-filesystem"]);

  const listed = listMcpServers(cwd).filter((server) => server.scope === "project");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].command, "npx");

  // Switching to an HTTP url drops the stdio fields, so the two forms cannot
  // both be set and confuse the transport inference.
  saveMcpServer(cwd, { name: "files", scope: "project", url: "https://example.com/mcp" });
  const updated = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(updated.servers.files.url, "https://example.com/mcp");
  assert.equal(updated.servers.files.command, undefined);

  removeMcpServer(cwd, "project", "files");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).servers, {});
});
