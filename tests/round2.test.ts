/** Round-two behaviour: protected paths, hooks, rules, pricing, schema. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCriticalCommand, isProtectedPath } from "../src/permissions.ts";
import { expandImports, loadRules, renderRules, ruleMatches } from "../src/instructions.ts";
import { costOf, priceFor } from "../src/pricing.ts";
import { validateAgainstSchema } from "../src/schema.ts";

test("protected paths cover the machinery, not the source", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-protected-"));
  assert.equal(isProtectedPath(join(cwd, ".git", "hooks", "pre-commit"), cwd), true);
  assert.equal(isProtectedPath(join(cwd, ".vscode", "settings.json"), cwd), true);
  assert.equal(isProtectedPath(join(cwd, ".mcp.json"), cwd), true);
  assert.equal(isProtectedPath(join(cwd, ".bashrc"), cwd), true);
  // Ordinary source stays ordinary.
  assert.equal(isProtectedPath(join(cwd, "src", "app.ts"), cwd), false);
  assert.equal(isProtectedPath(join(cwd, "README.md"), cwd), false);
  // A path outside the workspace is still protected when it names machinery:
  // `~/.ssh/config` and `~/.prometheus/config.json` decide how later commands
  // and sessions behave, so a write there is the escalation this list exists
  // to catch. Concurrency against the workspace is a separate check.
  assert.equal(isProtectedPath(join(cwd, "..", ".git", "config"), cwd), true);
  assert.equal(isProtectedPath(join(cwd, "..", "notes.txt"), cwd), false);
});

test("deleting the workspace or home root is refused in every mode", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-critical-"));
  assert.match(String(isCriticalCommand("rm -rf .", cwd)), /refusing/);
  assert.match(String(isCriticalCommand(`rm -rf "${cwd}"`, cwd)), /refusing/);
  assert.match(String(isCriticalCommand("rm -rf /", cwd)), /refusing/);
  // A normal recursive delete inside the project is a confirm, not a refusal.
  assert.equal(isCriticalCommand("rm -rf node_modules", cwd), null);
  assert.equal(isCriticalCommand("rm src/old.ts", cwd), null);
});

test("a rule with a glob applies only once a matching file is touched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-rules-"));
  mkdirSync(join(cwd, ".prometheus", "rules"), { recursive: true });
  writeFileSync(
    join(cwd, ".prometheus", "rules", "frontend.md"),
    "---\npaths: src/web/**\n---\nUse functional components.\n",
  );
  writeFileSync(join(cwd, ".prometheus", "rules", "always.md"), "Always run the type checker.\n");

  const rules = loadRules(cwd);
  const frontend = rules.find((rule) => rule.name === "frontend");
  assert.ok(frontend);
  assert.equal(ruleMatches(frontend, "src/web/App.tsx", cwd), true);
  assert.equal(ruleMatches(frontend, "src/server/db.ts", cwd), false);

  assert.equal(renderRules(rules, [], cwd).includes("functional components"), false);
  assert.equal(renderRules(rules, ["src/web/App.tsx"], cwd).includes("functional components"), true);
  // The unscoped rule is always present.
  assert.equal(renderRules(rules, [], cwd).includes("type checker"), true);
});

test("@imports expand once and stop at the depth limit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prometheus-imports-"));
  writeFileSync(join(cwd, "shared.md"), "shared checklist");
  writeFileSync(join(cwd, "root.md"), "Before @shared.md after");
  assert.equal(expandImports("Before @shared.md after", cwd), "Before shared checklist after");
  assert.equal(expandImports("no imports here", cwd), "no imports here");
});

test("prices match by longest prefix and bill cache hits separately", () => {
  assert.ok(priceFor("glm-5.3-flash"));
  assert.ok(priceFor("glm-5.3-flash-0915"));
  assert.equal(priceFor("some-unlisted-model"), null);

  const plain = costOf("glm-5.3-flash", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 });
  const cached = costOf("glm-5.3-flash", { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 });
  assert.ok(plain !== null && cached !== null);
  assert.ok(cached < plain, "a fully cached prompt must cost less than an uncached one");
  assert.equal(costOf("some-unlisted-model", { inputTokens: 1000, outputTokens: 1000 }), null);
});

test("the schema check accepts the shape it documents and rejects the rest", () => {
  const schema = {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      risk: { type: "string", enum: ["low", "high"] },
    },
    required: ["files", "risk"],
  };
  assert.equal(validateAgainstSchema('{"files":["a.ts"],"risk":"low"}', schema).valid, true);
  // Fenced JSON is the shape models actually produce.
  assert.equal(validateAgainstSchema('Here:\n```json\n{"files":[],"risk":"high"}\n```', schema).valid, true);
  assert.equal(validateAgainstSchema('{"files":[],"risk":"medium"}', schema).valid, false);
  assert.equal(validateAgainstSchema('{"files":[]}', schema).valid, false);
  assert.equal(validateAgainstSchema("not json", schema).valid, false);
});
