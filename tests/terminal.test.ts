/** Terminal stream parsing: markers split command output from completion events. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkerParser } from "../desktop/terminal.js";

const MARKER = "__PROMETHEUS_DONE__";

test("output before a marker is shown and the marker is consumed", () => {
  const parser = new MarkerParser();
  const result = parser.feed(`hello\r\n${MARKER}C:\\work\r\n`);
  assert.equal(result.text, "hello\r\n");
  assert.deepEqual(result.completed, ["C:\\work"]);
});

test("a marker split across chunks is held back until its newline arrives", () => {
  const parser = new MarkerParser();
  const first = parser.feed(`done\r\n__PROMETHEUS`);
  assert.equal(first.text, "done\r\n");
  assert.deepEqual(first.completed, []);
  const second = parser.feed(`_DONE__C:\\work\r\nnext`);
  assert.deepEqual(second.completed, ["C:\\work"]);
  assert.equal(second.text, "next");
});

test("output after a marker stays visible", () => {
  const parser = new MarkerParser();
  const result = parser.feed(`a\n${MARKER}/repo\nafter\n`);
  assert.equal(result.text, "a\nafter\n");
  assert.deepEqual(result.completed, ["/repo"]);
});

test("an empty marker path is reported but not applied", () => {
  const parser = new MarkerParser();
  const result = parser.feed(`${MARKER}\r\n`);
  assert.deepEqual(result.completed, [""]);
  assert.equal(result.text, "");
});

/* ---------- live shell behaviour ---------- */

const win = process.platform === "win32" ? test : test.skip;

/** Collect output until the shell reports itself idle, or the timeout hits. */
function waitIdle(session, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the shell never went idle")), timeoutMs);
    const states = [];
    const previous = session.onState;
    session.onState = (state) => {
      states.push(state);
      previous?.(state);
      if (!state.busy) {
        clearTimeout(timer);
        session.onState = previous;
        resolve(states);
      }
    };
  });
}

win("a command runs and the shell reports the working directory", async () => {
  const { TerminalSession } = await import("../desktop/terminal.js");
  const chunks = [];
  const session = new TerminalSession({
    cwd: process.cwd(),
    onOutput: (text) => chunks.push(text),
    onState: () => {},
  });
  try {
    const idle = waitIdle(session);
    assert.equal(session.run("echo prometheus-terminal"), true);
    await idle;
    assert.match(chunks.join(""), /prometheus-terminal/);
    assert.equal(session.busy, false);
  } finally {
    session.dispose();
  }
});

win("a second command is refused while one is running", async () => {
  const { TerminalSession } = await import("../desktop/terminal.js");
  const session = new TerminalSession({ cwd: process.cwd(), onOutput: () => {}, onState: () => {} });
  try {
    assert.equal(session.run("ping -n 30 127.0.0.1 >nul"), true);
    assert.equal(session.run("echo too-soon"), false, "the pane must not interleave two commands");
  } finally {
    session.dispose();
  }
});

win("interrupt marks the shell exited so the next command starts a fresh one", async () => {
  const { TerminalSession } = await import("../desktop/terminal.js");
  const session = new TerminalSession({ cwd: process.cwd(), onOutput: () => {}, onState: () => {} });
  try {
    session.run("ping -n 30 127.0.0.1 >nul");
    session.interrupt();
    // Synchronously after interrupt: `kill()` is async, but the state must
    // already say exited, or the next keystroke is refused for no reason.
    assert.equal(session.exited, true);
    assert.equal(session.busy, false);
  } finally {
    session.dispose();
  }
});

/* ---------- the fixes the research found ---------- */

test("a multi-line command is base64-encoded so the sentinel cannot be swallowed", async () => {
  const { encodeCommand } = await import("../desktop/terminal.js");
  const encoded = encodeCommand("if ($true) {\n  echo hi\n}", "powershell");
  assert.match(encoded, /FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(encoded)[1];
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "if ($true) {\n  echo hi\n}");
  // A POSIX shell has no such problem, so its command is passed through.
  assert.equal(encodeCommand("echo hi", "posix"), "echo hi");
});

test("non-ASCII survives the encoding", async () => {
  const { encodeCommand } = await import("../desktop/terminal.js");
  const encoded = encodeCommand("echo 中文路径", "powershell");
  const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(encoded)[1];
  assert.equal(Buffer.from(payload, "base64").toString("utf8"), "echo 中文路径");
});

test("interactive programs are recognised instead of hanging the pane", async () => {
  const { looksInteractive } = await import("../desktop/terminal.js");
  assert.equal(looksInteractive("vim src/a.ts"), true);
  assert.equal(looksInteractive("python"), true);
  assert.equal(looksInteractive("ssh host"), true);
  // A pipeline is a normal command even though the first word matched.
  assert.equal(looksInteractive("python script.py --flag"), false);
  assert.equal(looksInteractive("git status"), false);
});

test("ANSI escapes are stripped before the marker split", async () => {
  const parser = new MarkerParser();
  const result = parser.feed(`\x1b[31mRED\x1b[0m\r\n${MARKER}C:\work\r\n`);
  assert.equal(result.text, "RED\r\n");
  assert.deepEqual(result.completed, ["C:\work"]);
});

test("a clear-screen escape leaves nothing behind", async () => {
  const parser = new MarkerParser();
  const result = parser.feed(`\x1b[2J\x1b[Hdone\n`);
  assert.equal(result.text, "done\n");
});
