/** Saved approval rules: ordering, matching, scope, and cleanup. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Rules live in the user's config directory. Point it at a fresh temp folder
// before importing the module, so a rule the user saved while using the app
// (an "always allow bash" sits above everything and wins the first match) does
// not change what this suite measures. `PROMETHEUS_HOME` is read at import
// time, which is why the assignment comes first.
const home = mkdtempSync(join(tmpdir(), "prometheus-rules-"));
process.env.PROMETHEUS_HOME = home;
const { addRule, loadRules, matchRule, removeRule, rulesFor } = await import("../src/rules.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

const created: string[] = [];

function rule(overrides: Partial<Parameters<typeof addRule>[0]> = {}) {
  const saved = addRule({
    tool: "bash",
    action: "allow",
    scope: "user",
    ...overrides,
  });
  created.push(saved.id);
  return saved;
}

test.after(() => {
  for (const id of created) removeRule(id);
});

test("the first matching rule wins, so a deny can sit above an allow", () => {
  rule({ tool: "bash", match: "git push --force*", action: "deny" });
  rule({ tool: "bash", match: "git push*", action: "allow" });
  const rules = loadRules();
  assert.equal(matchRule(rules, "bash", "git push --force origin main")?.action, "deny");
  assert.equal(matchRule(rules, "bash", "git push origin main")?.action, "allow");
});

test("a tool-wide rule matches any detail, an exact rule matches only that detail", () => {
  rule({ tool: "list_files", match: "", action: "allow" });
  rule({ tool: "write_file", match: "src/app.ts", action: "allow" });
  const rules = loadRules();
  assert.equal(matchRule(rules, "list_files", "anything/at/all")?.tool, "list_files");
  assert.equal(matchRule(rules, "write_file", "src/app.ts")?.tool, "write_file");
  assert.equal(matchRule(rules, "write_file", "src/other.ts"), null);
});

test("a wildcard tool covers every tool", () => {
  rule({ tool: "*", match: "*.log", action: "allow" });
  const rules = loadRules();
  assert.equal(matchRule(rules, "read_file", "logs/build.log")?.tool, "*");
  assert.equal(matchRule(rules, "grep", "src/main.ts"), null);
});

test("project rules only apply to their own workspace", () => {
  const cwd = "C:/projects/alpha";
  const saved = rule({ tool: "bash", match: "npm test*", scope: "project", cwd, action: "allow" });
  assert.ok(rulesFor(cwd).some((entry) => entry.id === saved.id), "the owning workspace sees the rule");
  assert.ok(!rulesFor("C:/projects/beta").some((entry) => entry.id === saved.id), "another workspace does not");
  // Matching is done over the rules that apply, so the workspace-scoped list is
  // what the permission layer hands to matchRule.
  assert.equal(matchRule(rulesFor("C:/projects/beta"), "bash", "npm test"), null);
  assert.equal(matchRule(rulesFor(cwd), "bash", "npm test")?.id, saved.id);
});

test("adding the same rule twice keeps one copy, and removal works", () => {
  const first = rule({ tool: "grep", match: "secret*", action: "allow" });
  const second = rule({ tool: "grep", match: "secret*", action: "allow" });
  const matches = loadRules().filter((entry) => entry.tool === "grep" && entry.match === "secret*");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, second.id, "the newer copy replaces the older one");
  assert.equal(removeRule(second.id), true);
  assert.equal(removeRule(second.id), false, "removing twice reports the miss");
  assert.ok(!loadRules().some((entry) => entry.id === first.id));
});

test("glob matching is case-insensitive and anchors the whole detail", () => {
  rule({ tool: "bash", match: "npm run build", action: "allow" });
  const rules = loadRules();
  assert.ok(matchRule(rules, "bash", "NPM RUN BUILD"));
  assert.equal(matchRule(rules, "bash", "npm run build --watch"), null);
});
