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
