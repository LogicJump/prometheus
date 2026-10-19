/**
 * Startup housekeeping for sessions.
 *
 * Two things go wrong when a process dies mid-turn: the session's status on
 * disk stays `working` forever, and any goal loop it was running exists only
 * in the dead process's memory. Both are cheap to detect at startup and both
 * are confusing to discover later — a sidebar full of rows that look busy but
 * do nothing.
 *
 * This module is pure logic over `listSessions`; the host decides when to run
 * it and what to tell the user.
 */

import { listSessions, updateSessionFlags, loadSession, type SessionSummary } from "./sessions.ts";

export interface RecoveredSession {
  id: string;
  title?: string;
  /** The goal the dead process was running, when it had one. */
  goal: { kind: "goal" | "loop"; text: string; round: number; maxRounds: number; history?: string[] };
  /** True when the last turn left a tool call unaccounted for. */
  interrupted: boolean;
}

/**
 * Mark every `working` session that is not this process's as interrupted.
 *
 * A status of `working` with no live run is not "still working": it is the
 * fingerprint of a process that was killed. Leaving it is worse than clearing
 * it, because the sidebar then lies about which conversations need attention.
 *
 * `live` names sessions this process is already driving — a second window on
 * the same machine must not clear the status of a run that is still going.
 */
export function sweepStaleStatus(live: Iterable<string> = []): SessionSummary[] {
  const keep = new Set(live);
  const swept: SessionSummary[] = [];
  for (const summary of listSessions(false, true)) {
    if (summary.status !== "working") continue;
    if (keep.has(summary.id)) continue;
    try {
      updateSessionFlags(summary.id, { status: "ready" });
      swept.push({ ...summary, status: "ready" });
    } catch {
      /* another writer holds it; leave it alone rather than fight */
    }
  }
  return swept;
}

/**
 * Sessions a restarted process should offer to resume.
 *
 * A session with a saved goal but no live loop is the one worth surfacing: the
 * user asked for a multi-round task and the process left before finishing it.
 * Interrupted tool calls are reported on the same row, because a resumed
 * conversation needs to know a tool may have run.
 */
export function recoverableSessions(): RecoveredSession[] {
  const out: RecoveredSession[] = [];
  for (const summary of listSessions(false)) {
    if (summary.archived) continue;
    if (!summary.goal) continue;
    // Mark it so the offer does not reappear on every start forever: a
    // recovery the user declined once is a decision, not a pending item.
    try {
      updateSessionFlags(summary.id, { goal: null });
    } catch {
      continue;
    }
    const session = loadSession(summary.id);
    out.push({
      id: summary.id,
      ...(summary.title ? { title: summary.title } : {}),
      goal: summary.goal,
      interrupted: session ? hasOrphanToolCall(session.messages) : true,
    });
  }
  return out;
}

/**
 * True when the last thing in a transcript is an unanswered tool call.
 *
 * A conversation that ends on an assistant message carrying `tool_calls` was
 * cut off between the request and the result. Trailing `tool` messages are
 * fine — they are the answers — so they are skipped before the check.
 */
export function hasOrphanToolCall(messages: { role: string; tool_calls?: unknown[] }[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool") continue;
    return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  }
  return false;
}

/** One line per recoverable session, for a startup notice. */
export function recoveryLines(sessions: RecoveredSession[]): string[] {
  return sessions.map((session) => {
    const label = session.title ?? session.id;
    const progress = `${session.goal.round}/${session.goal.maxRounds}`;
    const note = session.interrupted ? ", last turn was cut off mid-tool" : "";
    return `${label} — ${session.goal.kind} round ${progress}: ${session.goal.text}${note}`;
  });
}
