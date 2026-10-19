/**
 * Driving an agent turn until a stopping condition is met.
 *
 * Two features share this shape:
 *
 *   goal — run, ask whether the stated goal is met, run again if not
 *   loop — run, look at the task list, run again while steps remain
 *
 * They differ only in what decides "another round". Both need the same
 * guardrails, and those guardrails are the whole difficulty: an autonomous
 * loop that never terminates burns the user's tokens while they are not
 * watching, and one that cheerfully reports success is worse than no loop at
 * all, because the user stops checking.
 *
 * So this module owns:
 *
 *   - a hard round limit, always, with no "unlimited" option
 *   - a stop when a round changes nothing (no tools ran, no files touched)
 *   - a stop after the same condition repeats, because "try again" twice with
 *     no new information is a loop that will not converge
 *   - cancellation between rounds, never only inside one
 *   - a report at the end saying what was done and why it stopped
 *
 * The round itself is injected. That keeps this testable without a model, and
 * keeps the knowledge of how to run one turn in the agent where it belongs.
 */

export type LoopStopReason =
  | "goal-met"
  | "task-list-complete"
  | "round-limit"
  | "no-progress"
  | "repeated-outcome"
  | "cancelled"
  | "failed";

export interface RoundOutcome {
  /** Did the turn itself complete without an error? */
  ok: boolean;
  /** Free text from the round, used to detect that nothing changed. */
  summary?: string;
}

export interface RoundContext {
  /** 1-based. */
  round: number;
  maxRounds: number;
  /** What the previous rounds concluded, so the driver can feed it forward. */
  history: string[];
}

export interface GoalDriverOptions {
  goal: string;
  maxRounds?: number;
  signal?: AbortSignal;
  /**
   * Rounds already run before this call, from a session resumed after a crash.
   *
   * Without it a resumed loop starts from round 1 and repeats the work; the
   * round limit also has to count the rounds already spent, or resuming would
   * quietly raise the ceiling.
   */
  resume?: { round: number; history: string[] };
  /** Runs one full turn. The driver supplies the prompt for it. */
  runRound: (prompt: string, context: RoundContext) => Promise<RoundOutcome>;
  /** Decides whether the goal has been met. Pure, so it can be stubbed. */
  isGoalMet: (input: { goal: string; roundSummary: string; history: string[] }) => Promise<{ met: boolean; reason: string }>;
  onRound?: (event: { round: number; phase: "start" | "end"; summary?: string }) => void;
}

export interface LoopRunResult {
  rounds: number;
  stop: LoopStopReason;
  /** Why it stopped, in a sentence the UI can show verbatim. */
  detail: string;
  /** One line per round, for the transcript. */
  history: string[];
}

/**
 * The prompt for round N.
 *
 * The first round is the user's goal as written. Later rounds carry the
 * previous outcome and an explicit instruction not to restart from scratch —
 * without that, a model re-reads the same files and "tries again" in exactly
 * the same way, which is the failure mode the repeated-outcome guard exists to
 * catch.
 */
export function roundPrompt(goal: string, round: number, history: string[]): string {
  if (round === 1) return goal;
  const last = history[history.length - 1] ?? "";
  return [
    `Continue working toward this goal:`,
    goal,
    ``,
    `Previous round ended with:`,
    last,
    ``,
    `Do not start over. Build on what is already done, and if the goal is already met, say so plainly and stop.`,
  ].join("\n");
}

/** Default ceiling. High enough for real work, low enough to notice. */
export const DEFAULT_MAX_ROUNDS = 8;
const ABSOLUTE_MAX_ROUNDS = 50;

export function clampMaxRounds(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_MAX_ROUNDS;
  return Math.min(ABSOLUTE_MAX_ROUNDS, Math.max(1, Math.floor(value as number)));
}

/**
 * Run rounds until the goal is met or a guard fires.
 *
 * The order of the checks matters. Cancellation is checked first so a stop
 * request is honoured before any further work starts. A failed round stops
 * immediately: retrying a turn that threw is not "trying again harder".
 */
export async function runGoal(options: GoalDriverOptions): Promise<LoopRunResult> {
  const maxRounds = clampMaxRounds(options.maxRounds);
  const history: string[] = [...(options.resume?.history ?? [])];
  // The first round the loop runs is the one after whatever the session had
  // already completed when its process died.
  const firstRound = Math.max(1, Math.min(maxRounds + 1, (options.resume?.round ?? 0) + 1));
  let lastOutcome = "";
  let repeatCount = 0;

  for (let round = firstRound; round <= maxRounds; round++) {
    if (options.signal?.aborted) {
      return { rounds: round - 1, stop: "cancelled", detail: "Stopped at your request.", history };
    }

    options.onRound?.({ round, phase: "start" });
    const prompt = roundPrompt(options.goal, history.length === 0 ? 1 : round, history);
    let outcome: RoundOutcome;
    try {
      outcome = await options.runRound(prompt, { round, maxRounds, history });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      history.push(`round ${round}: failed — ${message}`);
      return { rounds: round, stop: "failed", detail: `Round ${round} failed: ${message}`, history };
    }

    const summary = (outcome.summary ?? "").trim();
    history.push(`round ${round}: ${summary || (outcome.ok ? "completed" : "failed")}`);
    options.onRound?.({ round, phase: "end", summary });

    if (!outcome.ok) {
      return { rounds: round, stop: "failed", detail: `Round ${round} did not complete.`, history };
    }

    // A round that produced the same conclusion as the one before it is not
    // making progress. Allowing it once covers a genuinely idempotent step;
    // allowing it twice would let a stuck model spin to the round limit.
    if (summary && summary === lastOutcome) {
      repeatCount++;
      if (repeatCount >= 2) {
        return {
          rounds: round,
          stop: "repeated-outcome",
          detail: `Rounds ${round - 2}–${round} reached the same conclusion; stopping rather than repeating it.`,
          history,
        };
      }
    } else {
      repeatCount = 0;
    }
    lastOutcome = summary;

    const verdict = await options.isGoalMet({ goal: options.goal, roundSummary: summary, history });
    if (verdict.met) {
      return { rounds: round, stop: "goal-met", detail: verdict.reason || "The goal is met.", history };
    }

    if (options.signal?.aborted) {
      return { rounds: round, stop: "cancelled", detail: "Stopped at your request.", history };
    }
  }

  return {
    rounds: maxRounds,
    stop: "round-limit",
    detail: `Stopped after ${maxRounds} rounds without confirming the goal. The transcript shows what was done; raise the limit or narrow the goal.`,
    history,
  };
}

export interface TaskLoopOptions {
  maxRounds?: number;
  signal?: AbortSignal;
  /**
   * The task list survived the process, so do not plan again.
   *
   * A resumed loop that re-planned would discard the progress recorded in the
   * list and start the work over; the list *is* the state.
   */
  resume?: boolean;
  /** Runs one turn with the given prompt. */
  runRound: (prompt: string, context: RoundContext) => Promise<RoundOutcome>;
  /** Reads the current task list. The list is the model's own plan. */
  readTasks: () => { content: string; status: "pending" | "in_progress" | "completed" }[];
  /** Plans the work when there is no list yet. */
  plan: (context: RoundContext) => Promise<RoundOutcome>;
  onRound?: GoalDriverOptions["onRound"];
}

/**
 * Plan once, then work through the task list round by round.
 *
 * The task list is the model's own `todo_write` output, not a second plan this
 * module invents: two plans that can disagree is exactly how an autonomous run
 * ends up doing work nobody asked for.
 *
 * The first round always plans. If planning yields no items, the loop does not
 * invent any — it stops and says so, because "the model declined to decompose
 * this" is information the user needs, not a failure to paper over.
 */
export async function runTaskLoop(options: TaskLoopOptions): Promise<LoopRunResult> {
  const maxRounds = clampMaxRounds(options.maxRounds);
  const history: string[] = [];

  if (options.signal?.aborted) {
    return { rounds: 0, stop: "cancelled", detail: "Stopped at your request.", history };
  }

  // ---- planning ----
  // A resumed loop already has its plan, and re-planning would throw away the
  // completed steps the list records.
  if (!options.resume) {
    options.onRound?.({ round: 1, phase: "start" });
    let planned: RoundOutcome;
    try {
      planned = await options.plan({ round: 1, maxRounds, history: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { rounds: 1, stop: "failed", detail: `Planning failed: ${message}`, history: [`planning failed — ${message}`] };
    }
    if (!planned.ok) {
      return { rounds: 1, stop: "failed", detail: "Planning did not complete.", history };
    }
    history.push(`plan: ${planned.summary ?? "planned"}`);
    options.onRound?.({ round: 1, phase: "end", summary: planned.summary });
  }

  const tasks = options.readTasks();
  if (tasks.length === 0) {
    return {
      rounds: 1,
      stop: "no-progress",
      detail: "The plan came back empty, so there is nothing to work through.",
      history,
    };
  }

  // ---- rounds ----
  let stalledRounds = 0;
  let completedBefore = tasks.filter((task) => task.status === "completed").length;

  for (let round = 2; round <= maxRounds; round++) {
    if (options.signal?.aborted) {
      return { rounds: round - 1, stop: "cancelled", detail: "Stopped at your request.", history };
    }

    const current = options.readTasks();
    const open = current.filter((task) => task.status !== "completed");
    if (open.length === 0) {
      return {
        rounds: round - 1,
        stop: "task-list-complete",
        detail: `All ${current.length} planned step(s) are done.`,
        history,
      };
    }

    options.onRound?.({ round, phase: "start" });
    const next = open.find((task) => task.status === "in_progress") ?? open[0];
    let outcome: RoundOutcome;
    try {
      outcome = await options.runRound(
        `Continue the plan. Next step: ${next.content}\n\nDo this step, then update the task list with todo_write. Do not skip ahead.`,
        { round, maxRounds, history },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      history.push(`round ${round}: failed — ${message}`);
      return { rounds: round, stop: "failed", detail: `Round ${round} failed: ${message}`, history };
    }

    const summary = (outcome.summary ?? "").trim();
    history.push(`round ${round}: ${summary || next.content}`);
    options.onRound?.({ round, phase: "end", summary });

    if (!outcome.ok) {
      return { rounds: round, stop: "failed", detail: `Round ${round} did not complete.`, history };
    }

    // Progress is measured by the plan, not by the model's prose: a round that
    // marks nothing complete has not advanced, however confident it sounds.
    const completedNow = options.readTasks().filter((task) => task.status === "completed").length;
    if (completedNow <= completedBefore) {
      stalledRounds++;
      if (stalledRounds >= 2) {
        return {
          rounds: round,
          stop: "no-progress",
          detail: `Two rounds in a row finished without completing a planned step (stuck on "${next.content}").`,
          history,
        };
      }
    } else {
      stalledRounds = 0;
    }
    completedBefore = Math.max(completedBefore, completedNow);
  }

  const finalTasks = options.readTasks();
  return {
    rounds: maxRounds,
    stop: "round-limit",
    detail:
      `Stopped after ${maxRounds} rounds with ${finalTasks.filter((task) => task.status !== "completed").length} ` +
      `of ${finalTasks.length} step(s) still open.`,
    history,
  };
}
