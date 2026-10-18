/** Session flags: pin ordering, rename, archive, delete. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { listSessions, loadSession, newSessionId, saveSession, updateSessionFlags, deleteSessionFile } from "../src/sessions.ts";

function makeSession(cwd: string) {
  const id = newSessionId();
  saveSession({
    id,
    cwd,
    model: "test",
    baseUrl: "http://localhost",
    createdAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: "user", content: `hello from ${id}` }],
  });
  return id;
}

test("pin, rename, and archive flags round-trip and affect listing", () => {
  const cwd = `C:/tmp/sessions-${Date.now()}`;
  const older = makeSession(cwd);
  const newer = makeSession(cwd);
  try {
    updateSessionFlags(older, { pinned: true, title: "Keep me" });
    const pinnedSession = loadSession(older);
    assert.equal(pinnedSession?.pinned, true);
    assert.equal(pinnedSession?.title, "Keep me");

    // Pinned sorts above a newer session.
    const listed = listSessions(false, true).filter((session) => session.cwd === cwd);
    assert.equal(listed[0].id, older);
    assert.equal(listed[0].title, "Keep me");

    updateSessionFlags(newer, { archived: true });
    const visible = listSessions(false, false).filter((session) => session.cwd === cwd);
    assert.ok(!visible.some((session) => session.id === newer), "archived sessions are hidden by default");
    const all = listSessions(false, true).filter((session) => session.cwd === cwd);
    assert.ok(all.some((session) => session.id === newer));

    // Clearing a title falls back to the first message.
    updateSessionFlags(older, { title: "  " });
    assert.equal(loadSession(older)?.title, undefined);
  } finally {
    deleteSessionFile(older);
    deleteSessionFile(newer);
  }
});

test("deleting a session removes its file", () => {
  const id = makeSession(`C:/tmp/sessions-del-${Date.now()}`);
  assert.ok(loadSession(id));
  assert.equal(deleteSessionFile(id), true);
  assert.equal(loadSession(id), null);
  assert.equal(deleteSessionFile(id), false);
});
