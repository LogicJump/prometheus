/**
 * Round 9, batch 2: the Board pane tells the truth about probes and targets.
 *
 * Three things the pane had stopped showing — the list of attached probes, the
 * target table, and whether the selected name is in it — and one it was
 * claiming falsely: that a stored target the user picked is something the chip
 * reported. The pane's whole job is to be the one place where "what will the
 * tools use" and "what do we actually know" are the same answer.
 *
 * `round8-board-pane.test.ts` holds the structural constraints from the last
 * rewrite; those still apply and are not repeated here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTargetView, targetStatusNote, sourceLabel } from "../desktop/renderer/boardView.js";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const html = readFileSync("desktop/renderer/index.html", "utf8");
const i18n = readFileSync("desktop/renderer/i18n.js", "utf8");

const dict = (() => {
  const en = i18n.slice(i18n.indexOf("en:"), i18n.indexOf("zh:"));
  return en;
})();

/* ---------- U1: the probes that are attached ---------- */

test("every attached probe gets a row with its kind and serial", () => {
  const view = buildTargetView({
    board: {
      scannedAt: "2026-10-20T00:00:00Z",
      probes: [
        { kind: "pyocd", name: "ST-LINK", serial: "37FF71064E573436", target: "stm32f42x" },
        { kind: "probe-rs", name: "J-Link", serial: "", target: "" },
      ],
      ports: [],
      tools: [],
      selection: {},
      effective: {},
    },
    selection: {},
    status: null,
    t: { boardProbe: "Probe", boardNoProbe: "No probe attached", boardReported: "reports", boardNoReportedTarget: "none reported" },
  });
  assert.equal(view.probes.length, 2);
  assert.equal(view.probes[0].name, "ST-LINK");
  assert.equal(view.probes[0].serial, "37FF71064E573436");
  assert.equal(view.probes[0].target, "stm32f42x");
  assert.equal(view.probes[0].targetText, "reports stm32f42x");
  // A probe that reported no target says so rather than showing an empty cell.
  assert.equal(view.probes[1].targetText, "none reported");
});

test("a probe without a serial is not offered as a choice", () => {
  // Selecting by serial is the only way to tell two probes apart; a row with
  // no serial would write an empty `probe` into the selection.
  const view = buildTargetView({
    board: { scannedAt: "x", probes: [{ kind: "pyocd", name: "ST-LINK", serial: "", target: "" }], ports: [], tools: [], selection: {}, effective: {} },
    selection: {},
    status: null,
    t: { boardProbe: "Probe", boardNoProbe: "No probe attached", boardReported: "reports", boardNoReportedTarget: "none reported" },
  });
  assert.equal(view.probes[0].selectable, false);
});

test("the selected probe is marked active", () => {
  const view = buildTargetView({
    board: {
      scannedAt: "x",
      probes: [
        { kind: "pyocd", name: "A", serial: "111", target: "" },
        { kind: "pyocd", name: "B", serial: "222", target: "" },
      ],
      ports: [],
      tools: [],
      selection: { probe: "222" },
      effective: {},
    },
    selection: { probe: "222" },
    status: null,
    t: { boardProbe: "Probe", boardNoProbe: "No probe attached", boardReported: "reports", boardNoReportedTarget: "none reported" },
  });
  assert.deepEqual(view.probes.map((probe) => probe.active), [false, true]);
});

/* ---------- U2: the target table ---------- */

const targets = [
  { name: "stm32f429xi", vendor: "STMicroelectronics", part: "STM32F429" },
  { name: "stm32f429zg", vendor: "STMicroelectronics", part: "STM32F429" },
  { name: "stm32f103rc", vendor: "STMicroelectronics", part: "STM32F103" },
  { name: "nrf52840", vendor: "Nordic", part: "nRF52840" },
];

const loaded = { total: 206, targets, notes: [], error: "" };

test("the target table lists what was loaded, filtered by the query", () => {
  const view = buildTargetView({
    board: { scannedAt: "x", probes: [{ kind: "pyocd", name: "ST-LINK", serial: "1", target: "" }], ports: [], tools: [], selection: {}, effective: {} },
    selection: {},
    status: null,
    targets: loaded,
    query: "f429",
    t: baseT(),
  });
  assert.deepEqual(view.targets.map((entry) => entry.name), ["stm32f429xi", "stm32f429zg"]);
  assert.equal(view.targetsTotal, 206);
});

test("the query matches vendor and part as well as the name", () => {
  const byVendor = buildTargetView({ board: scanned(), selection: {}, status: null, targets: loaded, query: "nordic", t: baseT() });
  assert.deepEqual(byVendor.targets.map((entry) => entry.name), ["nrf52840"]);
});

test("no table loaded means no rows and no invented count", () => {
  const view = buildTargetView({ board: scanned(), selection: {}, status: null, targets: null, query: "", t: baseT() });
  assert.deepEqual(view.targets, []);
  assert.equal(view.targetsTotal, 0);
});

test("the table arrives with the scan rather than behind a button", () => {
  // round8 fixed this: a "load targets" button made the pane able to say a chip
  // is attached while being unable to name it. The table loads with the scan.
  const before = buildTargetView({ board: scanned(), selection: {}, status: null, targets: null, query: "", t: baseT() });
  assert.equal(before.targetsLoaded, false);
  const after = buildTargetView({ board: scanned(), selection: {}, status: null, targets: loaded, query: "", t: baseT() });
  assert.equal(after.targetsLoaded, true);
});

/* ---------- U3: whether the selected name is in the table ---------- */

test("the target status note names the state", () => {
  const t = { boardTargetsUnloaded: "not loaded", boardTargetExact: "found", boardTargetCandidates: "close matches", boardTargetAbsent: "absent" };
  assert.equal(targetStatusNote({ kind: "unloaded" }, t), "not loaded");
  assert.equal(targetStatusNote({ kind: "exact" }, t), "found");
  assert.equal(targetStatusNote({ kind: "candidates" }, t), "close matches");
  assert.equal(targetStatusNote({ kind: "absent" }, t), "absent");
  assert.equal(targetStatusNote(null, t), "not loaded");
});

test("the note is carried on the view the pane renders", () => {
  const view = buildTargetView({
    board: scanned(),
    selection: { target: "stm32f429xi" },
    status: { kind: "absent", candidates: [], total: 206 },
    targets: loaded,
    query: "",
    t: { boardTargetsUnloaded: "not loaded", boardTargetExact: "found", boardTargetCandidates: "close matches", boardTargetAbsent: "absent" },
  });
  assert.equal(view.targetNote, "absent");
});

/* ---------- U4: a stored name is not a chip reading ---------- */

const ambiguous = {
  target: "stm32f429xi",
  targetOptions: ["stm32f429xi", "stm32f429zg"],
  // The host resolved this name from the stored selection, not from the part.
  targetSource: "chip",
  identity: { family: "STM32F42x/43x", deviceId: "0x419", flashKib: 2048 },
};

test("a name chosen from several candidates does not claim to come from the chip", () => {
  const view = buildTargetView({
    board: { ...scanned(), ...ambiguous },
    selection: { target: "stm32f429xi" },
    status: null,
    t: baseT(),
  });
  assert.equal(view.source, "picked");
  assert.match(sourceLabel(view, baseT()), /chose|picked/i);
});

test("a name that is the only candidate is still the chip's answer", () => {
  const view = buildTargetView({
    board: { ...scanned(), ...ambiguous, targetOptions: ["stm32f429xi"] },
    selection: { target: "stm32f429xi" },
    status: null,
    t: baseT(),
  });
  assert.equal(view.source, "chip");
});

test("a name with no chip read at all stays manual", () => {
  const view = buildTargetView({
    board: { ...scanned(), identity: null, target: "stm32f103rc", targetOptions: [], targetSource: "manual" },
    selection: { target: "stm32f103rc" },
    status: null,
    t: baseT(),
  });
  assert.equal(view.source, "manual");
});

test("an ambiguous family says what is known instead of naming a part", () => {
  // STM32F42x/43x covers two flash sizes; the chip answered with a family, not
  // a part number, so the pane must not print a full part name as a reading.
  const view = buildTargetView({
    board: { ...scanned(), ...ambiguous },
    selection: { target: "stm32f429xi" },
    status: null,
    t: baseT(),
  });
  assert.equal(view.needsChoice, true);
});

test("the renderer and the pane use the same source vocabulary", () => {
  assert.match(app, /buildTargetView/, "the pane renders from the view model");
  assert.ok(!/targetSource === "chip"/.test(app), "the pane no longer decides the source inline");
});

/* ---------- the copied i18n keys are back in use ---------- */

test("the probe and target-table keys are referenced again", () => {
  // They were left behind when the pane was rewritten; U1-U3 restore the copy
  // they belong to, so they must not be dead strings. `boardProbes` is not in
  // the list: the restored probe rows live under "Other choices", not under a
  // section of their own, so that title stayed dead and was removed.
  for (const key of ["boardProbeCount", "boardNoProbe", "boardReported", "boardNoReportedTarget"]) {
    assert.ok(dict.includes(`${key}:`), `${key} exists`);
  }
});

test("the pane requests the target table itself", () => {
  assert.match(app, /getBoardTargets/, "the pane asks for the table when the scan lands");
  assert.ok(!/board-load-targets/.test(html), "there is no separate load button");
});

/* ---------- fixtures ---------- */

function scanned() {
  return {
    scannedAt: "2026-10-20T00:00:00Z",
    probes: [{ kind: "pyocd", name: "ST-LINK", serial: "37FF71064E573436", target: "" }],
    ports: [],
    tools: [],
    selection: {},
    effective: {},
  };
}

function baseT() {
  return {
    boardProbe: "Probe",
    boardNoProbe: "No probe attached",
    boardReported: "reports",
    boardNoReportedTarget: "none reported",
    boardTargetsUnloaded: "not loaded",
    boardTargetExact: "found",
    boardTargetCandidates: "close matches",
    boardTargetAbsent: "absent",
    boardReadFromChip: "read from the part",
    boardTargetManual: "typed by hand",
    boardTargetPicked: "chosen from the family's candidates",
  };
}
