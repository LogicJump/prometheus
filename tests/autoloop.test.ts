/**
 * The autonomous-loop drivers.
 *
 * The thing worth testing here is not that the loop runs — it is that every
 * way an autonomous run can go wrong has a stop. A test that only proves the
 * happy path would tell us nothing about the case that costs the user money.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampMaxRounds,
  DEFAULT_MAX_ROUNDS,
  roundPrompt,
  runGoal,
  runTaskLoop,
  type RoundContext,
} from "../src/autoloop.ts";

function scripted(rounds: { ok?: boolean; summary: string }[]) {
  let index = 0;
  const prompts: string[] = [];
  return {
    prompts,
    runRound: async (prompt: string, _context: RoundContext) => {
      prompts.push(prompt);
      const step = rounds[Math.min(index++, rounds.length - 1)];
      return { ok: step.ok ?? true, summary: step.summary };
    },
  };
}

test("a goal loop stops as soon as the goal is met", async () => {
  const runner = scripted([{ summary: "added the parser" }, { summary: "tests pass" }]);
  let checks = 0;
  const result = await runGoal({
    goal: "make the parser handle nested input",
    runRound: runner.runRound,
    isGoalMet: async ({ roundSummary }) => {
      checks++;
      return { met: roundSummary.includes("tests pass"), reason: "Tests pass." };
    },
  });
  assert.equal(result.stop, "goal-met");
  assert.equal(result.rounds, 2);
  assert.equal(checks, 2);
  assert.equal(result.detail, "Tests pass.");
});

test("a goal loop always stops at the round limit, and says so", async () => {
  // Each round must conclude something *different*, or the repeated-outcome
  // guard fires first and this test would be measuring the wrong stop.
  let round = 0;
  const result = await runGoal({
    goal: "impossible",
    maxRounds: 3,
    runRound: async () => ({ ok: true, summary: `attempt ${++round}` }),
    isGoalMet: async () => ({ met: false, reason: "" }),
  });
  assert.equal(result.stop, "round-limit");
  assert.equal(result.rounds, 3);
  assert.match(result.detail, /3 rounds/);
});

test("a round limit cannot be raised past the hard ceiling", () => {
  assert.equal(clampMaxRounds(undefined), DEFAULT_MAX_ROUNDS);
  assert.equal(clampMaxRounds(0), 1);
  assert.equal(clampMaxRounds(-5), 1);
  assert.equal(clampMaxRounds(1e9), 50);
  assert.equal(clampMaxRounds(Number.NaN), DEFAULT_MAX_ROUNDS);
  assert.equal(clampMaxRounds(3.7), 3);
});

test("a loop that reaches the same conclusion three times stops instead of spinning", async () => {
  // The failure this guards: the model says "I will try a different approach"
  // every round and never actually changes anything.
  const runner = scripted([{ summary: "same conclusion" }]);
  let rounds = 0;
  const result = await runGoal({
    goal: "fix it",
    maxRounds: 8,
    runRound: async (prompt, context) => {
      rounds++;
      return runner.runRound(prompt, context);
    },
    isGoalMet: async () => ({ met: false, reason: "" }),
  });
  assert.equal(result.stop, "repeated-outcome");
  // Three rounds: the first establishes the conclusion, the next two repeat it.
  assert.equal(rounds, 3);
  assert.match(result.detail, /same conclusion/);
});

test("a failed round stops the loop rather than retrying it", async () => {
  const result = await runGoal({
    goal: "anything",
    maxRounds: 5,
    runRound: async () => ({ ok: false, summary: "the API returned 400" }),
    isGoalMet: async () => ({ met: true, reason: "should never be asked" }),
  });
  assert.equal(result.stop, "failed");
  assert.equal(result.rounds, 1);
});

test("a runRound that throws is reported, not swallowed", async () => {
  const result = await runGoal({
    goal: "anything",
    runRound: async () => {
      throw new Error("connection reset");
    },
    isGoalMet: async () => ({ met: true, reason: "" }),
  });
  assert.equal(result.stop, "failed");
  assert.match(result.detail, /connection reset/);
});

test("cancelling between rounds stops before the next one starts", async () => {
  const controller = new AbortController();
  let rounds = 0;
  const result = await runGoal({
    goal: "long job",
    maxRounds: 10,
    signal: controller.signal,
    runRound: async () => {
      rounds++;
      controller.abort();
      return { ok: true, summary: `round ${rounds}` };
    },
    isGoalMet: async () => ({ met: false, reason: "" }),
  });
  assert.equal(result.stop, "cancelled");
  assert.equal(rounds, 1, "the second round must not run after the abort");
});

test("later rounds carry the previous outcome and forbid starting over", () => {
  const first = roundPrompt("ship the feature", 1, []);
  assert.equal(first, "ship the feature");
  const later = roundPrompt("ship the feature", 3, ["round 1: a", "round 2: b"]);
  assert.match(later, /ship the feature/);
  assert.match(later, /round 2: b/);
  assert.match(later, /Do not start over/);
});

// ---- task loop -------------------------------------------------------------

function taskHarness(plan: string[], completions: number[][]) {
  // `completions[i]` is the set of task indexes completed after round i+1.
  let completed: number[] = [];
  let round = 0;
  const prompts: string[] = [];
  return {
    prompts,
    readTasks: () => plan.map((content, index) => ({ content, status: completed.includes(index) ? "completed" : "pending" })),
    plan: async () => ({ ok: true, summary: `planned ${plan.length} steps` }),
    runRound: async (prompt: string) => {
      prompts.push(prompt);
      completed = completions[Math.min(round, completions.length - 1)] ?? completed;
      round++;
      return { ok: true, summary: `worked ${plan[0]}` };
    },
    completed: () => completed,
  };
}

test("a task loop works the list until every step is done", async () => {
  // After round 2 both steps are complete.
  const harness = taskHarness(["a", "b"], [[0], [0, 1]]);
  const result = await runTaskLoop({
    readTasks: harness.readTasks,
    plan: harness.plan,
    runRound: harness.runRound,
  });
  assert.equal(result.stop, "task-list-complete");
  assert.equal(result.detail, "All 2 planned step(s) are done.");
  // Round 2 completes "a", round 3 completes "b", round 4 sees an empty list
  // and stops without running: two work rounds.
  assert.equal(harness.prompts.length, 2);
  assert.match(harness.prompts[0], /Next step: a/);
});

test("an empty plan stops instead of inventing work", async () => {
  const result = await runTaskLoop({
    readTasks: () => [],
    plan: async () => ({ ok: true, summary: "nothing to do" }),
    runRound: async () => ({ ok: true, summary: "should not run" }),
  });
  assert.equal(result.stop, "no-progress");
  assert.equal(result.rounds, 1);
  assert.match(result.detail, /nothing to work through/);
});

test("two rounds without completing a step stops the loop", async () => {
  // The model keeps "working" but never ticks anything off. That is stuck,
  // not busy.
  const harness = taskHarness(["a", "b"], [[], [], []]);
  const result = await runTaskLoop({
    readTasks: harness.readTasks,
    plan: harness.plan,
    runRound: harness.runRound,
    maxRounds: 6,
  });
  assert.equal(result.stop, "no-progress");
  assert.match(result.detail, /stuck on "a"/);
});

test("a task loop hits its round limit with the open count named", async () => {
  // Each round completes one step, so the no-progress guard never fires and
  // the only remaining stop is the limit.
  const harness = taskHarness(["a", "b", "c"], [[0], [0, 1], [0, 1], [0, 1], [0, 1, 2]]);
  const result = await runTaskLoop({
    readTasks: harness.readTasks,
    plan: harness.plan,
    runRound: harness.runRound,
    maxRounds: 4,
  });
  assert.equal(result.stop, "round-limit");
  assert.match(result.detail, /1 of 3 step\(s\) still open/);
});

test("a task loop reports planning failure rather than running unplanned", async () => {
  const result = await runTaskLoop({
    readTasks: () => [],
    plan: async () => {
      throw new Error("model unavailable");
    },
    runRound: async () => ({ ok: true, summary: "should not run" }),
  });
  assert.equal(result.stop, "failed");
  assert.match(result.detail, /model unavailable/);
});

test("a task loop stops when cancelled before it starts", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runTaskLoop({
    signal: controller.signal,
    readTasks: () => [{ content: "a", status: "pending" }],
    plan: async () => ({ ok: true, summary: "planned" }),
    runRound: async () => ({ ok: true, summary: "should not run" }),
  });
  assert.equal(result.stop, "cancelled");
  assert.equal(result.rounds, 0);
});
