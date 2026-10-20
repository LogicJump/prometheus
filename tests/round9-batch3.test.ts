/**
 * Round 9, batch 3: the serial pane can be entered directly, and a tool never
 * flashes a board nobody identified.
 *
 * U5 — opening the Serial tab straight from the sidebar left the port dropdown
 * empty, because the port list only existed after the Board pane had scanned.
 * The Start button then returned silently. Nothing said why.
 *
 * U6 — chip identification ran only when the Board pane scanned. A user who
 * went straight to the agent got the stored target from `config.board`, which
 * is a memory of the last board, and `embed_flash` wrote firmware for a chip
 * that may not be plugged in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serialPortChoices, startBlockedReason } from "../desktop/renderer/serialView.js";
import { IdentificationNeed } from "../src/embedded/identifyGate.ts";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const host = readFileSync("desktop/host.js", "utf8");

/* ---------- U5: the port list outside the Board pane ---------- */

test("the dropdown is filled from the host's port list, not from board state", () => {
  const choices = serialPortChoices({
    ports: [
      { path: "COM7", description: "USB Serial" },
      { path: "COM3", board: "Nucleo" },
    ],
    current: "",
    saved: "",
  });
  assert.deepEqual(choices.map((entry) => entry.path), ["COM7", "COM3"]);
  assert.equal(choices[0].label, "COM7 — USB Serial");
});

test("the saved selection is preselected even when it is not first", () => {
  const choices = serialPortChoices({ ports: [{ path: "COM7" }, { path: "COM3" }], current: "", saved: "COM3" });
  assert.equal(choices.find((entry) => entry.selected).path, "COM3");
});

test("a single port is preselected with no saved selection", () => {
  const choices = serialPortChoices({ ports: [{ path: "COM7" }], current: "", saved: "" });
  assert.equal(choices[0].selected, true);
});

test("two ports and no saved selection preselected nothing", () => {
  // Guessing between two ports is how firmware gets flashed or a console read
  // on the wrong device.
  const choices = serialPortChoices({ ports: [{ path: "COM7" }, { path: "COM3" }], current: "", saved: "" });
  assert.equal(choices.some((entry) => entry.selected), false);
});

test("no ports yields no choices and a reason to say so", () => {
  assert.deepEqual(serialPortChoices({ ports: [], current: "", saved: "" }), []);
  assert.equal(startBlockedReason({ open: false, port: "", ports: [] }), "noPort");
});

test("starting with no port chosen is refused with a reason", () => {
  assert.equal(startBlockedReason({ open: false, port: "", ports: [{ path: "COM7" }, { path: "COM3" }] }), "choosePort");
  assert.equal(startBlockedReason({ open: false, port: "COM7", ports: [{ path: "COM7" }] }), "");
  // An open monitor needs no port; the button is Stop.
  assert.equal(startBlockedReason({ open: true, port: "", ports: [] }), "");
});

test("opening the serial pane asks for ports when the scan has not run", () => {
  const start = app.indexOf("function openSerialPane");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(body, /serialPorts|getBoardState/, "the pane requests a port list");
  assert.match(body, /serialStatus/, "the ring is still fetched");
});

test("the host answers a port list without a full scan", () => {
  assert.match(host, /case "serialPorts"/, "a dedicated command exists");
});

test("Start says why it did nothing", () => {
  const start = app.indexOf('$("serial-toggle").addEventListener("click"');
  const body = app.slice(start, app.indexOf("\n});", start));
  assert.ok(!/if \(!port\) return;/.test(body), "no silent return");
  assert.match(body, /startBlockedReason/, "the decision is shared with the test");
  assert.match(body, /addNotice|renderSerialStatus/, "the reason becomes visible");
});

/* ---------- U6: identify before flashing ---------- */

test("a configured board with no identification must be identified first", () => {
  const need = new IdentificationNeed();
  assert.equal(need.shouldIdentify({ board: { target: "stm32f103rc" }, identity: null }), true);
});

test("nothing to identify with means nothing to wait for", () => {
  const need = new IdentificationNeed();
  assert.equal(need.shouldIdentify({ board: { target: "stm32f103rc" }, identity: null, probes: 0 }), false);
  assert.equal(need.shouldIdentify({ board: {}, identity: null }), false);
});

test("once identified, a second flash does not scan again", () => {
  const need = new IdentificationNeed();
  assert.equal(need.shouldIdentify({ board: { target: "stm32f103rc" }, identity: null, probes: 1 }), true);
  need.markIdentified();
  assert.equal(need.shouldIdentify({ board: { target: "stm32f103rc" }, identity: null, probes: 1 }), false);
});

test("a scan that found no probe backs off instead of retrying every call", () => {
  const need = new IdentificationNeed();
  need.markIdentified();
  assert.equal(need.shouldIdentify({ board: { target: "x" }, identity: null, probes: 1 }), false);
});

test("a changed selection reopens the question", () => {
  const need = new IdentificationNeed();
  need.markIdentified();
  need.noteSelection({ target: "stm32f103rc" });
  assert.equal(need.shouldIdentify({ board: { target: "stm32f429xi" }, identity: null, probes: 1 }), true);
});

test("the host identifies before a flash that would otherwise use a stored name", () => {
  assert.match(host, /ensureIdentified/, "the flash path consults the gate");
});
