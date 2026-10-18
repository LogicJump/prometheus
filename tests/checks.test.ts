/** CI check rollup summarization. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeChecks } from "../desktop/git.js";

test("Actions-style checks are counted by conclusion", () => {
  const summary = summarizeChecks([
    { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "test", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "lint", status: "IN_PROGRESS", conclusion: null },
    { name: "deploy", status: "QUEUED", conclusion: null },
  ]);
  assert.deepEqual(summary, { total: 4, passed: 1, failed: 1, pending: 2, failing: ["test"] });
});

test("status-context checks use state instead of conclusion", () => {
  const summary = summarizeChecks([
    { name: "ci/ok", state: "SUCCESS" },
    { name: "ci/bad", state: "FAILURE" },
    { name: "ci/wait", state: "PENDING" },
  ]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 1);
  assert.deepEqual(summary.failing, ["ci/bad"]);
});

test("an empty or missing rollup is all zeros", () => {
  assert.deepEqual(summarizeChecks([]), { total: 0, passed: 0, failed: 0, pending: 0, failing: [] });
  assert.deepEqual(summarizeChecks(null), { total: 0, passed: 0, failed: 0, pending: 0, failing: [] });
});
