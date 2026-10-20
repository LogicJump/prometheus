/**
 * Round 9, batch 4: the serial pane can send, and what it shows can be handed
 * to the agent.
 *
 * The host has had `serialWrite` since the pane was written, and the renderer
 * never sent it: the pane was a viewer. The same went for "send selection to
 * the agent", which the plan promised and no code implemented.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeSend, writtenNotice } from "../desktop/renderer/serialView.js";
import { selectedLinesAsQuote } from "../desktop/renderer/serialView.js";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const html = readFileSync("desktop/renderer/index.html", "utf8");
const host = readFileSync("desktop/host.js", "utf8");

/* ---------- U11: writing ---------- */

test("a line ending is appended only when the user asked for one", () => {
  assert.equal(encodeSend("help", "lf"), "help\n");
  assert.equal(encodeSend("help", "crlf"), "help\r\n");
  assert.equal(encodeSend("help", "none"), "help");
});

test("a bootloader command with no ending is sent exactly as typed", () => {
  // A `\n` appended to a bootloader prompt answers a question nobody asked.
  assert.equal(encodeSend("0x08000000", "none"), "0x08000000");
});

test("an empty line with an ending is still a real send", () => {
  assert.equal(encodeSend("", "lf"), "\n");
});

test("the pane has a send field and a send action", () => {
  assert.match(html, /id="serial-send-input"/);
  assert.match(html, /id="serial-send"/);
  assert.match(html, /id="serial-send-ending"|serialSendEnding/);
});

test("Enter sends, Shift+Enter inserts a newline", () => {
  const start = app.indexOf('$("serial-send-input")');
  assert.ok(start > -1, "the field exists in the renderer");
  const body = app.slice(start, start + 1400);
  assert.match(body, /keydown/);
  assert.match(body, /shiftKey/);
  assert.match(body, /serialWrite/);
});

test("the write result is shown, and a failure is not silent", () => {
  assert.match(app, /case "serial_written"/);
  assert.match(app, /case "serial_snapshot"/);
  assert.match(host, /serial_written/);
});

test("the status line reports bytes written", () => {
  assert.equal(writtenNotice({ port: "COM7", bytes: 5 }, "已发送"), "已发送 COM7 · 5 B");
});

/* ---------- U12: handing lines to the agent ---------- */

const lines = [
  { at: 1, text: "[00:00:01] boot" },
  { at: 2, text: "[00:00:02] ERROR: i2c timeout" },
  { at: 3, text: "[00:00:03] retrying" },
];

test("a selection becomes a quoted block with the port named", () => {
  const quote = selectedLinesAsQuote({ port: "COM7", lines: [lines[1]] });
  assert.match(quote, /COM7/);
  assert.match(quote, /ERROR: i2c timeout/);
  assert.match(quote, /```/);
});

test("several selected lines keep their order", () => {
  const quote = selectedLinesAsQuote({ port: "COM7", lines });
  const first = quote.indexOf("boot");
  const last = quote.indexOf("retrying");
  assert.ok(first > -1 && last > first);
});

test("an empty selection produces nothing to insert", () => {
  assert.equal(selectedLinesAsQuote({ port: "COM7", lines: [] }), "");
});

test("the output rows carry the index the selection needs", () => {
  assert.match(app, /dataset\.lineIndex|data-line-index/);
});

test("there is an action to send the selection", () => {
  assert.match(html, /id="serial-to-agent"/);
  assert.match(app, /selectedLinesAsQuote/);
});

test("the inserted text reaches the composer rather than being sent immediately", () => {
  // Sending on the user's behalf would spend a turn they did not ask for.
  const start = app.indexOf('$("serial-to-agent")');
  const body = app.slice(start, start + 900);
  assert.match(body, /input\.value/);
  assert.ok(!/cmd:\s*"submit"|sendPrompt\(/.test(body), "it fills the composer, it does not submit");
});
