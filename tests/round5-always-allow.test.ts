/**
 * "Always allow" must never become "always allow everything".
 *
 * The permission layer stores an approval as a rule whose `match` is what the
 * user actually saw. For "every call of this tool" the rule deliberately has
 * no `match` — and `matchRuleAgainst` reads a missing match as "matches any
 * detail", which is right for an explicit `Bash(*)` or a whole-tool grant but
 * catastrophic here: it made one click on "Always allow" in front of
 *
 *   bash: npm test
 *
 * authorize every later command in the workspace for the life of the rules
 * file. `rm -rf build` and `npm install` were audited as "allowed by rule".
 *
 * A bash grant is only ever as wide as the command the user approved; a
 * whole-tool grant is fine for a tool whose arguments are not arbitrary code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "prometheus-rules-scope-"));
process.env.PROMETHEUS_HOME = home;

const { addRule, loadRules, matchRuleAgainst, rulesFor, ruleFromChoice } = await import("../src/rules.ts");
const { Permissions } = await import("../src/permissions.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

const bashTool = {
  name: "bash",
  description: "",
  parameters: {},
  readonly: false,
  summarize: (input: string extends never ? never : Record<string, unknown>) => String(input.command ?? ""),
  execute: async () => ({ content: "" }),
} as never;

test("a whole-tool bash grant does not match a command the user never approved", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-rules-ws-"));
  try {
    const saved = ruleFromChoice("bash", "", "project", workspace, "always-tool");
    const rules = rulesFor(workspace);
    assert.ok(rules.some((rule) => rule.id === saved.id));

    // "Every call of bash" cannot be honoured as a rule: its arguments are the
    // program being run. The stored rule therefore matches nothing and the
    // prompt reappears with a real command line on it. Before the fix every
    // one of these matched, because a missing `match` meant "any detail".
    for (const command of ["npm test", "npm install", "rm -rf build", "git push --force"]) {
      assert.equal(
        matchRuleAgainst(rules, "bash", `${command} — something`, command),
        null,
        `"always allow bash" must not authorize: ${command}`,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a whole-tool grant still works for a tool whose arguments are not commands", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-rules-ws-"));
  try {
    ruleFromChoice("write_file", "", "project", workspace, "always-tool");
    const rules = rulesFor(workspace);
    assert.ok(matchRuleAgainst(rules, "write_file", "src/a.ts", "src/a.ts"));
    assert.ok(matchRuleAgainst(rules, "write_file", "docs/b.md", "docs/b.md"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("one-click Always Allow in the permission prompt does not open the shell", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-rules-ws-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    const asked: string[] = [];
    let scopeQuestions = 0;
    const ui = {
      info() {},
      dim() {},
      warn() {},
      error() {},
      assistantText() {},
      assistantEnd() {},
      toolStart() {},
      toolEnd() {},
      thinking() {},
      thinkingEnd() {},
      todos() {},
      spinnerStart() {},
      spinnerStop() {},
      async confirm(question: string) {
        asked.push(question);
        return "always" as const;
      },
      // No `ask`: the terminal path, where "always" means this tool.
      async ask() {
        scopeQuestions += 1;
        return "always-tool";
      },
    };
    const manager = new Permissions(
      {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        model: "m",
        maxTokens: 1000,
        permissionMode: "ask",
        contextWindow: 128000,
        maxTurns: 10,
        allowedDirs: [],
        autoApprove: [],
        sandbox: "enforce",
        networkPolicy: "off",
      } as never,
      ui as never,
    );

    assert.equal((await manager.check(bashTool, { command: "npm test" })).allowed, true);
    assert.equal(asked.length, 1, "the approved command asked, and was allowed");
    // The scope question is not offered for a shell: it has one honest answer,
    // and a dialog whose second button is ignored is worse than no dialog.
    assert.equal(scopeQuestions, 0, "a bash approval asks no scope question");

    // The same manager, a different command: it must ask again.
    const second = await manager.check(bashTool, { command: "rm -rf src" });
    assert.equal(asked.length, 2, "a different command has to be approved on its own");
    assert.equal(second.allowed, true, "and the scripted answer still allows it");
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an explicit Bash(*) rule still covers every command", () => {
  // The escape hatch has to keep working: a user who writes `Bash(*)` in
  // settings means every command, and CI grants rely on it.
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-rules-ws-"));
  try {
    addRule({ tool: "bash", match: "*", action: "allow", scope: "project", cwd: workspace });
    const rules = rulesFor(workspace);
    for (const command of ["npm test", "rm -rf build", "git push --force"]) {
      assert.ok(matchRuleAgainst(rules, "bash", command, command), `Bash(*) must cover ${command}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the rules file stays readable after the change", () => {
  // A migration is not needed: the fix is in matching, not in the stored
  // shape, so existing files keep loading.
  assert.ok(Array.isArray(loadRules()));
});
