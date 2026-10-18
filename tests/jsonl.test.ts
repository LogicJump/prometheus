/**
 * JSONL session storage, isolated in its own tests (SESSIONS_DIR is fixed at
 * module load, so every assertion works off the real directory).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../src/config.ts";
import {
  appendMessages,
  deleteSessionFile,
  listSessions,
  loadMessages,
  loadSession,
  newSessionId,
  replaceMessages,
  saveSession,
  updateSessionFlags,
} from "../src/sessions.ts";
import type { ChatMessage } from "../src/types.ts";

function baseRecord(id: string, messages: ChatMessage[]) {
  return {
    id,
    cwd: "C:/tmp/jsonl-test",
    model: "test",
    baseUrl: "http://localhost",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages,
  };
}

test("a new session is stored as a directory with generation 0001", () => {
  const id = newSessionId();
  try {
    saveSession(baseRecord(id, [{ role: "user", content: "hello" }]));
    const dir = join(SESSIONS_DIR, id);
    assert.ok(existsSync(join(dir, "meta.json")));
    assert.ok(existsSync(join(dir, "messages.0001.jsonl")));
    const files = readdirSync(dir);
    assert.ok(!files.some((file) => file.endsWith(".json") && file !== "meta.json"), "no legacy single file");
    assert.equal(loadMessages(id).length, 1);
  } finally {
    deleteSessionFile(id);
  }
});

test("appends only write the new tail", () => {
  const id = newSessionId();
  try {
    saveSession(baseRecord(id, [{ role: "user", content: "one" }]));
    appendMessages(id, [{ role: "assistant", content: "two" }]);
    appendMessages(id, [{ role: "user", content: "three" }]);
    const messages = loadMessages(id);
    assert.deepEqual(
      messages.map((message) => message.content),
      ["one", "two", "three"],
    );
  } finally {
    deleteSessionFile(id);
  }
});

test("a rewritten (compacted) conversation starts a new generation and keeps the old one", () => {
  const id = newSessionId();
  try {
    saveSession(baseRecord(id, [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]));
    replaceMessages(id, [{ role: "user", content: "recap: one and three" }]);
    const dir = join(SESSIONS_DIR, id);
    const files = readdirSync(dir).filter((file) => file.startsWith("messages.")).sort();
    assert.deepEqual(files, ["messages.0001.jsonl", "messages.0002.jsonl"]);
    assert.deepEqual(
      loadMessages(id).map((message) => message.content),
      ["recap: one and three"],
    );
    // saveSession with a shorter array also detects the rewrite.
    saveSession(baseRecord(id, [{ role: "user", content: "shorter" }]));
    assert.equal(loadSession(id)?.generation, 3);
  } finally {
    deleteSessionFile(id);
  }
});

test("a legacy single-file session is readable and migrates on save", () => {
  const id = `legacy-${Date.now()}`;
  const file = join(SESSIONS_DIR, `${id}.json`);
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ ...baseRecord(id, [{ role: "user", content: "old format" }]), title: "Legacy" }),
      "utf8",
    );
    const loaded = loadSession(id);
    assert.equal(loaded?.title, "Legacy");
    assert.equal(loaded?.messages.length, 1);

    saveSession({ ...loaded!, messages: [...loaded!.messages, { role: "assistant", content: "new" }] });
    assert.ok(!existsSync(file), "legacy file is removed after migration");
    assert.ok(existsSync(join(SESSIONS_DIR, id, "meta.json")));
    assert.equal(loadMessages(id).length, 2);
  } finally {
    deleteSessionFile(id);
    rmSync(file, { force: true });
  }
});

test("flags survive an append and listing still sorts pinned first", () => {
  const id = newSessionId();
  try {
    saveSession(baseRecord(id, [{ role: "user", content: "pick me" }]));
    updateSessionFlags(id, { pinned: true, title: "Pinned" });
    appendMessages(id, [{ role: "assistant", content: "ok" }]);
    const flagged = loadSession(id);
    assert.equal(flagged?.pinned, true);
    assert.equal(flagged?.title, "Pinned");
    const listed = listSessions(false, true).find((session) => session.id === id);
    assert.equal(listed?.pinned, true);
    assert.match(listed?.summary ?? "", /pick me/);
  } finally {
    deleteSessionFile(id);
  }
});

test("sessions in the same folder are one project even when stored with different separators", () => {
  const a = newSessionId();
  const b = newSessionId();
  const folder = `C:/tmp/project-${Date.now()}`;
  const slash = "/";
  const backslash = String.fromCharCode(92);
  try {
    saveSession({ ...baseRecord(a, [{ role: "user", content: "one" }]), cwd: folder });
    saveSession({ ...baseRecord(b, [{ role: "user", content: "two" }]), cwd: folder.split(slash).join(backslash) });
    const listed = listSessions(false, true).filter((session) => session.cwd.split(backslash).join(slash) === folder);
    assert.equal(listed.length, 2);
    // The renderer groups on a normalized key; both spellings must collapse.
    const keys = new Set(listed.map((session) => session.cwd.split(backslash).join(slash).toLowerCase()));
    assert.equal(keys.size, 1);
  } finally {
    deleteSessionFile(a);
    deleteSessionFile(b);
  }
});
