/**
 * Round-three 4.2: two writers, one session.
 *
 * The transcript is append-only, which makes two appends *safe* to read and
 * unsafe to write: both writers advance `messageCount` and `lastHash` from a
 * meta file that now describes the other writer's tail. The lock is the fix;
 * these tests pin both the lock and the refusal that makes it load-bearing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { SESSIONS_DIR } from "../src/config.ts";
import { newSessionId, saveSession, loadSession, ForeignSessionWriter, deleteSessionFile } from "../src/sessions.ts";
import {
  acquireSessionLock,
  holdsSessionLock,
  isProcessAlive,
  releaseSessionLock,
  sessionLockHolder,
} from "../src/sessionLock.ts";

const testId = () => `round3-lock-${newSessionId()}`;

function baseSession(id) {
  return {
    id,
    cwd: process.cwd(),
    model: "test-model",
    baseUrl: "http://127.0.0.1:1/v1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: "user", content: "hello" }],
  };
}

function cleanup(id) {
  deleteSessionFile(id);
  rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
}

test("a free session can be claimed exactly once", () => {
  const id = testId();
  try {
    const first = acquireSessionLock(id, "test");
    assert.equal(first.ok, true);
    assert.equal(holdsSessionLock(id), true);

    // Same process re-acquiring is a reload, not a conflict.
    const again = acquireSessionLock(id, "test");
    assert.equal(again.ok, true);
  } finally {
    releaseSessionLock(id);
    cleanup(id);
  }
});

test("a lock whose process is gone is stale and is taken over", () => {
  const id = testId();
  try {
    mkdirSync(join(SESSIONS_DIR, id), { recursive: true });
    // A pid that cannot be running: above every platform's pid ceiling.
    writeFileSync(
      join(SESSIONS_DIR, id, ".lock"),
      JSON.stringify({ pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString(), label: "crashed" }),
      "utf8",
    );
    assert.equal(isProcessAlive(999_999_999), false);
    const claim = acquireSessionLock(id, "test");
    assert.equal(claim.ok, true, "a crashed writer must not make a session unopenable");
  } finally {
    releaseSessionLock(id);
    cleanup(id);
  }
});

test("a lock from another machine is not trusted as a live writer", () => {
  const id = testId();
  try {
    mkdirSync(join(SESSIONS_DIR, id), { recursive: true });
    writeFileSync(
      join(SESSIONS_DIR, id, ".lock"),
      JSON.stringify({ pid: process.pid, host: "some-other-host", acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    // The pid is this process, but it means nothing on another machine: pids
    // are a per-machine namespace.
    assert.equal(sessionLockHolder(id), null);
    assert.equal(acquireSessionLock(id, "test").ok, true);
  } finally {
    releaseSessionLock(id);
    cleanup(id);
  }
});

test("a lock from a dead process is cleared; a live holder is reported", () => {
  const id = testId();
  try {
    mkdirSync(join(SESSIONS_DIR, id), { recursive: true });
    writeFileSync(
      join(SESSIONS_DIR, id, ".lock"),
      JSON.stringify({ pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    assert.equal(sessionLockHolder(id), null, "a dead pid is stale");

    // Find a pid that is certainly alive but is not this process.
    let live = 0;
    for (let candidate = process.pid + 1; candidate < process.pid + 64 && !live; candidate++) {
      if (isProcessAlive(candidate) && candidate !== process.pid) live = candidate;
    }
    // On a machine with no other process nearby this branch is skipped rather
    // than asserting on a coincidence.
    if (live > 0) {
      writeFileSync(
        join(SESSIONS_DIR, id, ".lock"),
        JSON.stringify({ pid: live, host: hostname(), acquiredAt: new Date().toISOString() }),
        "utf8",
      );
      assert.equal(sessionLockHolder(id)?.pid, live, "a live writer is reported");
    }
  } finally {
    releaseSessionLock(id);
    cleanup(id);
  }
});

test("saveSession refuses to write a session another process owns", () => {
  const id = testId();
  try {
    saveSession(baseSession(id));
    // Stand in for the other window. A pid just above this one is usually live
    // but is not guaranteed to exist, and a lock held by a dead pid is cleared
    // as stale — which would make this test pass for the wrong reason. Probe a
    // short range and pick one that answers.
    let standIn = 0;
    for (let candidate = process.pid + 1; candidate < process.pid + 64 && !standIn; candidate++) {
      if (isProcessAlive(candidate) && candidate !== process.pid) standIn = candidate;
    }
    assert.ok(standIn > 0, "found a live pid that is not this process");
    const lockPath = join(SESSIONS_DIR, id, ".lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: standIn, host: hostname(), acquiredAt: new Date().toISOString(), label: "desktop window" }),
      "utf8",
    );

    const session = loadSession(id);
    assert.ok(session);
    session.messages.push({ role: "assistant", content: "second writer" });
    assert.throws(() => saveSession(session), ForeignSessionWriter);

    // The first writer's transcript is untouched.
    const stored = loadSession(id);
    assert.equal(stored?.messages.length, 1);
  } finally {
    rmSync(join(SESSIONS_DIR, id, ".lock"), { force: true });
    cleanup(id);
  }
});

test("a writer that holds the lock saves normally", () => {
  const id = testId();
  try {
    saveSession(baseSession(id));
    assert.equal(acquireSessionLock(id, "test").ok, true);
    const session = loadSession(id);
    assert.ok(session);
    session.messages.push({ role: "assistant", content: "same owner" });
    saveSession(session);
    assert.equal(loadSession(id)?.messages.length, 2);
  } finally {
    releaseSessionLock(id);
    cleanup(id);
  }
});

test("releasing a lock this process does not own leaves it alone", () => {
  const id = testId();
  try {
    mkdirSync(join(SESSIONS_DIR, id), { recursive: true });
    // Any pid that is not ours: use a dead one so the lock is also stale,
    // which is enough to prove release does not delete a bystander's file.
    const payload = JSON.stringify({ pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(join(SESSIONS_DIR, id, ".lock"), payload, "utf8");
    releaseSessionLock(id);
    const still = JSON.parse(readFileSync(join(SESSIONS_DIR, id, ".lock"), "utf8"));
    assert.equal(still.pid, 999_999_999);
  } finally {
    rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
  }
});

/* ---------- permission_choice is wired, not dead UI ---------- */

// The desktop renders a second question after "always allow": remember every
// call of the tool, or only this exact one. That UI existed with no caller,
// and "always" silently granted the whole tool. The label promised a narrower
// grant than the code made.

const permissionTool = {
  name: "bash",
  description: "test tool",
  readonly: false,
  parameters: { type: "object", properties: {} },
  summarize: (input) => String(input.command ?? ""),
  execute: async () => ({ content: "" }),
};

test("a UI that can ask scopes the grant to the exact call when asked to", async () => {
  const { Permissions } = await import("../src/permissions.ts");
  const { CONFIG_HOME } = await import("../src/config.ts");
  const { join } = await import("node:path");
  const { existsSync, readFileSync, rmSync } = await import("node:fs");
  // `Permissions` writes the rule it is told to remember into the user's real
  // rules file. Snapshot it and put it back, so this test leaves no approval
  // behind for a later run to honour.
  const rulesPath = join(CONFIG_HOME, "rules.json");
  const before = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : null;
  // A command no other test or session has an approval for.
  const command = `round3-scope-${newSessionId()}`;
  const asked = [];
  const prompted = [];
  const ui = {
    confirm: async (question) => {
      prompted.push(question);
      return "always";
    },
    ask: async (question, options) => {
      asked.push({ question, options });
      return "always-detail";
    },
    spinnerStart() {},
    spinnerStop() {},
    setModelName() {},
    echoUser() {},
    todoList() {},
    todos() {},
    assistantStart() {},
    assistantDelta() {},
    assistantEnd() {},
    thinkingStart() {},
    thinkingDelta() {},
    thinkingEnd() {},
    toolStart() {},
    toolEnd() {},
    toolOutput() {},
    notice() {},
    error() {},
    info() {},
    warn() {},
    dim() {},
    success() {},
    renderPlan() {},
    takeLineDirty: () => false,
  };
  const permissions = new Permissions({ permissionMode: "ask", autoApprove: [] }, ui);
  try {
    const verdict = await permissions.check(permissionTool, { command });
    assert.equal(verdict.allowed, true);
    // A shell is never offered the scope question: "every call of bash" would
    // be a grant to run anything, so there is only one honest answer and the
    // dialog is skipped.
    assert.equal(asked.length, 0, "no scope question for a shell command");

    // A second, different command must ask again: the grant was for one call.
    const second = await permissions.check(permissionTool, { command: `${command}-other` });
    assert.equal(second.allowed, true);
    assert.equal(prompted.length, 2, "the unrelated command was not covered by the first approval");

    // A UI with no ask keeps the narrow default without failing.
    const quiet = new Permissions({ permissionMode: "ask", autoApprove: [] }, { ...ui, ask: undefined });
    assert.equal((await quiet.check(permissionTool, { command: `${command}-quiet` })).allowed, true);
  } finally {
    if (before === null) rmSync(rulesPath, { force: true });
    else writeFileSync(rulesPath, before, "utf8");
  }
});
