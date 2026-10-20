/**
 * Waveforms and instrument drivers.
 *
 * Everything here runs without hardware: a VCD file is text, a Joulescope or
 * PPK2 capture is text, and a scope CSV is text. What cannot be tested without
 * a device is the command invocation itself, and that is a string comparison.
 *
 * The parsers are header-driven and refuse rather than guess, and these tests
 * pin that: a reordered CSV must fail loudly, not swap volts for amps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ---------- VCD ---------- */

test("a VCD header declares channels and the body records their edges", async () => {
  const { parseVcd } = await import("../src/embedded/waveform.ts");
  const text = [
    "$date today $end",
    "$timescale 1ns $end",
    "$scope module top $end",
    "$var wire 1 ! clk $end",
    "$var wire 8 \" data $end",
    "$upscope $end",
    "$enddefinitions $end",
    "$dumpvars",
    "0!",
    "b00000000 \"",
    "$end",
    "#10",
    "1!",
    "#20",
    "0!",
    "b10101010 \"",
    "#30",
    "$finish",
  ].join("\n");
  const waveform = parseVcd(text);
  assert.equal(waveform.timescale, "1ns");
  assert.equal(waveform.duration, 30);
  assert.equal(waveform.channels.length, 2);
  const clock = waveform.channels.find((channel) => channel.name === "top.clk");
  assert.equal(clock?.transitions.length, 3);
  assert.deepEqual(
    clock?.transitions.map((entry) => `${entry.t}:${entry.value}`),
    ["0:0", "10:1", "20:0"],
  );
  const data = waveform.channels.find((channel) => channel.name === "top.data");
  assert.equal(data?.transitions[1].value, "10101010");
  assert.deepEqual(waveform.notes, []);
});

test("a timescale spread over three lines is still read", async () => {
  const { parseVcd } = await import("../src/embedded/waveform.ts");
  const text = ["$timescale", "1 ps", "$end", "$enddefinitions $end", "#5", "1!", "$finish"].join("\n");
  const waveform = parseVcd(text);
  assert.equal(waveform.timescale, "1 ps");
  // The scalar has no $var declaration: it is kept and noted, not dropped.
  assert.equal(waveform.channels.length, 1);
  assert.ok(waveform.notes.some((note) => note.includes("undeclared")));
});

test("a file that is not VCD says so instead of returning zero channels", async () => {
  const { parseVcd } = await import("../src/embedded/waveform.ts");
  const waveform = parseVcd("hello\nworld\n");
  assert.equal(waveform.channels.length, 0);
  assert.ok(waveform.notes.some((note) => note.includes("not a VCD")));
});

/* ---------- digitizing ---------- */

test("a square wave becomes alternating rise and fall edges", async () => {
  const { digitize } = await import("../src/embedded/waveform.ts");
  const samples = Array.from({ length: 100 }, (_, index) => ({ t: index / 1000, value: index % 10 < 5 ? 3.3 : 0 }));
  const trace = digitize(samples, { name: "pulse" });
  // Starts high, then flips every five samples: 2 * (100/10) edges minus the
  // start marker.
  assert.equal(trace.initial, 1);
  assert.ok(trace.edges.length >= 19);
  assert.equal(trace.edges[1].edge, "fall");
  assert.ok(Math.abs(trace.duty - 0.5) < 0.02, `duty ${trace.duty}`);
  assert.ok(trace.threshold > 1 && trace.threshold < 2.5);
});

test("an explicit threshold is used verbatim", async () => {
  const { digitize } = await import("../src/embedded/waveform.ts");
  const samples = [{ t: 0, value: 0 }, { t: 1, value: 1.0 }, { t: 2, value: 2.0 }];
  const trace = digitize(samples, { threshold: 1.5 });
  assert.equal(trace.threshold, 1.5);
  assert.deepEqual(trace.edges.map((edge) => edge.level), [0, 1]);
});

test("a flat capture reports no edges rather than a duty cycle", async () => {
  const { digitize } = await import("../src/embedded/waveform.ts");
  const trace = digitize([{ t: 0, value: 1 }, { t: 1, value: 1 }]);
  assert.equal(trace.edges.length, 1);
  assert.ok(trace.notes.some((note) => note.includes("never moved")));
  assert.ok(trace.notes.some((note) => note.includes("no transitions")));
});

test("samples near the threshold are counted as possible noise", async () => {
  const { digitize } = await import("../src/embedded/waveform.ts");
  const samples = [
    { t: 0, value: 0 },
    { t: 1, value: 1.0 },
    { t: 2, value: 1.01 },
    { t: 3, value: 2.0 },
  ];
  const trace = digitize(samples);
  assert.ok(trace.notes.some((note) => note.includes("within 5%")));
});

/* ---------- Joulescope ---------- */

test("Joulescope columns are mapped by header, not position", async () => {
  const { parseJoulescopeCsv } = await import("../src/embedded/instrumentDrivers.ts");
  const result = parseJoulescopeCsv("time,voltage,current\n0,3.3,0.001\n0.1,3.3,0.002\n");
  assert.equal(result.ok, true);
  assert.equal(result.samples?.length, 2);
  // If the parser used positions, current would be 0.001 at index 1.
  assert.equal(result.samples?.[0].voltage, 3.3);
  assert.equal(result.samples?.[0].current, 0.001);
});

test("a Joulescope file without a header is refused", async () => {
  const { parseJoulescopeCsv } = await import("../src/embedded/instrumentDrivers.ts");
  const result = parseJoulescopeCsv("0,3.3,0.001\n");
  assert.equal(result.ok, false);
  assert.match(String(result.error), /header/);
});

/* ---------- PPK2 ---------- */

test("PPK2 JSON converts microseconds and microamps", async () => {
  const { parsePpk2Output } = await import("../src/embedded/instrumentDrivers.ts");
  const result = parsePpk2Output(JSON.stringify({ samples: [{ t_us: 1000, current_ua: 5000 }, { t_us: 2000, current_ua: 2500 }] }));
  assert.equal(result.ok, true);
  assert.equal(result.samples?.[0].t, 0.001);
  assert.equal(result.samples?.[0].current, 0.005);
});

test("PPK2 CSV with a microsecond time column is normalized", async () => {
  const { parsePpk2Output } = await import("../src/embedded/instrumentDrivers.ts");
  const result = parsePpk2Output("timestamp_us,current_uA\n1000000,1200\n2000000,800\n");
  assert.equal(result.ok, true);
  assert.equal(result.samples?.[0].t, 1);
  assert.equal(result.samples?.[0].current, 0.0012);
});

test("malformed PPK2 output is an error, not an empty measurement", async () => {
  const { parsePpk2Output } = await import("../src/embedded/instrumentDrivers.ts");
  const result = parsePpk2Output("something went wrong");
  assert.equal(result.ok, false);
  assert.match(String(result.error), /unreadable/);
});

/* ---------- sigrok ---------- */

test("sigrok builds a VCD capture command", async () => {
  const { sigrokCommand } = await import("../src/embedded/instrumentDrivers.ts");
  const command = sigrokCommand({ durationMs: 500, driver: "fx2lafw", channels: "D0,D1" });
  assert.ok(command);
  assert.equal(command.program, "sigrok-cli");
  assert.deepEqual(command.args, ["--time", "0.5", "-O", "vcd", "-d", "fx2lafw", "-C", "D0,D1"]);
});

test("sigrok output without VCD content is refused with the first line", async () => {
  const { sigrokResult } = await import("../src/embedded/instrumentDrivers.ts");
  const result = sigrokResult("no devices found\n");
  assert.equal(result.ok, false);
  assert.match(String(result.error), /no devices found/);
});

/* ---------- driver table ---------- */

test("every advertised driver has a program to look for", async () => {
  const { DRIVERS, driverFor } = await import("../src/embedded/instrumentDrivers.ts");
  for (const driver of DRIVERS) {
    assert.ok(driver.programs.length > 0, `${driver.kind} has no program`);
  }
  // `scpi` is the name the tool documented before drivers existed; it still
  // resolves to the pyvisa driver rather than becoming an unknown instrument.
  assert.equal(driverFor("scpi")?.kind, "pyvisa");
  assert.equal(driverFor("nonesuch"), undefined);
});

/* ---------- the tools ---------- */

test("embed_waveform is registered and reads a VCD from the workspace", async () => {
  const { ALL_TOOLS } = await import("../src/tools/index.ts");
  const tool = ALL_TOOLS.find((candidate) => candidate.name === "embed_waveform");
  assert.ok(tool, "embed_waveform is not in the tool list");
  const dir = mkdtempSync(join(tmpdir(), "prom-wave-"));
  try {
    writeFileSync(
      join(dir, "capture.vcd"),
      ["$timescale 1ns $end", "$var wire 1 ! clk $end", "$enddefinitions $end", "#0", "0!", "#10", "1!", "$finish"].join("\n"),
      "utf8",
    );
    const result = await tool.execute({ path: "capture.vcd" }, { cwd: dir } as never);
    assert.equal(result.isError, undefined);
    assert.match(String(result.content), /1 transition|2 transition/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embed_waveform turns a two-column CSV into edges", async () => {
  const { runtimeTools } = await import("../src/tools/embeddedRuntimeTools.ts");
  const tool = runtimeTools.find((candidate) => candidate.name === "embed_waveform");
  assert.ok(tool);
  const dir = mkdtempSync(join(tmpdir(), "prom-wave-"));
  try {
    writeFileSync(join(dir, "scope.csv"), "time,voltage\n0,0\n0.1,3.3\n0.2,3.3\n0.3,0\n", "utf8");
    const result = await tool.execute({ path: "scope.csv" }, { cwd: dir } as never);
    assert.match(String(result.content), /rise/);
    assert.match(String(result.content), /fall/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embed_waveform refuses an unknown binary capture format by name", async () => {
  const { runtimeTools } = await import("../src/tools/embeddedRuntimeTools.ts");
  const tool = runtimeTools.find((candidate) => candidate.name === "embed_waveform");
  assert.ok(tool);
  const dir = mkdtempSync(join(tmpdir(), "prom-wave-"));
  try {
    writeFileSync(join(dir, "capture.sr"), "\u0001\u0002binary", "utf8");
    const result = await tool.execute({ path: "capture.sr" }, { cwd: dir } as never);
    assert.equal(result.isError, true);
    assert.match(String(result.content), /VCD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
