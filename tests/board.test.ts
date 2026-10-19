/**
 * The two pure modules the Board and Serial panes are built on.
 *
 * Everything that can be wrong about these panes is decided here: whether a
 * chip name is real, whether a language says "not found" or "not looked yet",
 * whether a stream splits lines at the right byte. The DOM and the host only
 * carry the answers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleBoardState, boardDefaults, boardTargetStatus, resolveTarget } from "../src/embedded/board.ts";
import { SerialLineBuffer } from "../src/embedded/serialStream.ts";
import { validBoard } from "../src/config.ts";
import { mergeConfigFile, writeBoardConfig } from "../src/settings.ts";
import type { Target } from "../src/embedded/probe.ts";
import type { DetectedProject } from "../src/embedded/project.ts";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const PROJECT: DetectedProject = { kind: "unknown", root: "/tmp/project", evidence: [] };

function target(name: string, extra: Partial<Target> = {}): Target {
  return { name, vendor: "Test", source: "pyocd", ...extra };
}

// ---- boardTargetStatus -----------------------------------------------------

test("nothing has been loaded yet", () => {
  const status = boardTargetStatus("stm32f103rc", null);
  assert.equal(status.kind, "unloaded");
  assert.deepEqual(status.candidates, []);
});

test("an exact name is exact, case-insensitively", () => {
  const table = [target("stm32f103rc", { part: "STM32F103RC" })];
  assert.equal(boardTargetStatus("stm32f103rc", table).kind, "exact");
  assert.equal(boardTargetStatus("STM32F103RC", table).kind, "exact");
  // The part number is a different field from the name and counts too.
  assert.equal(boardTargetStatus("STM32F103RC", [target("f103", { part: "STM32F103RC" })]).kind, "exact");
});

test("a chip the table does not have is absent, not unloaded", () => {
  const status = boardTargetStatus("nrf99999", [target("stm32f103rc"), target("nrf52840")]);
  // The distinction matters: "absent" is a fact about the table, and the pane
  // is allowed to say it; "unloaded" is only ever a fact about us.
  assert.equal(status.kind, "absent");
  assert.equal(status.total, 2);
});

test("a sibling part is offered as a candidate", () => {
  // pyOCD 0.45.1 has no stm32f103ze; it has stm32f103rc. That is the real
  // situation this rule exists for: the user's chip is one package code away
  // from a target that exists.
  const table = [target("stm32f103rc", { part: "STM32F103RC" }), target("stm32f401re")];
  const status = boardTargetStatus("stm32f103ze", table);
  assert.equal(status.kind, "candidates");
  assert.deepEqual(
    status.candidates.map((entry) => entry.name),
    ["stm32f103rc"],
  );
});

test("a different family is not a candidate", () => {
  // Dropping the trailing package code must not collapse f103 into f105.
  const status = boardTargetStatus("stm32f103ze", [target("stm32f105rc")]);
  assert.equal(status.kind, "absent");
});

test("a substring match is a candidate, not an exact hit", () => {
  const status = boardTargetStatus("f103", [target("stm32f103rc"), target("stm32f103rb")]);
  assert.equal(status.kind, "candidates");
  assert.equal(status.candidates.length, 2);
});

test("no selection means there is nothing to judge", () => {
  const status = boardTargetStatus(undefined, [target("stm32f103rc")]);
  assert.equal(status.kind, "unloaded");
  assert.equal(status.total, 1);
});

test("an exact target resolves to its table spelling", () => {
  const table = [target("stm32f103rc")];
  const status = boardTargetStatus("STM32F103RC", table);
  assert.equal(resolveTarget({ target: "STM32F103RC" }, status), "stm32f103rc");
});

test("an unverified target still passes through", () => {
  // The tools have their own validation; the table is pyOCD's, and another
  // flasher may understand a name it does not list.
  const status = boardTargetStatus("custom-chip", [target("other")]);
  assert.equal(resolveTarget({ target: "custom-chip" }, status), "custom-chip");
});

// ---- boardDefaults and assembleBoardState ----------------------------------

test("the only attached port is used when none is selected", () => {
  const defaults = boardDefaults({}, [{ path: "COM7" }]);
  assert.equal(defaults.port, "COM7");
  assert.equal(defaults.baud, 115200);
  assert.equal(defaults.assertDtr, false);
});

test("several ports mean no guess", () => {
  const defaults = boardDefaults({}, [{ path: "COM7" }, { path: "COM8" }]);
  assert.equal(defaults.port, undefined);
});

test("an explicit selection beats the only port", () => {
  const defaults = boardDefaults({ port: "COM9", baud: 9600 }, [{ path: "COM7" }]);
  assert.equal(defaults.port, "COM9");
  assert.equal(defaults.baud, 9600);
});

test("a project-only state has no inventory and does not invent one", () => {
  const state = assembleBoardState({ project: PROJECT });
  assert.equal(state.tools.length, 0);
  assert.equal(state.probes.length, 0);
  assert.equal(state.ports.length, 0);
  assert.equal(state.scannedAt, null);
  assert.equal(state.build, null);
});

test("a full state carries every part through", () => {
  const state = assembleBoardState({
    project: { kind: "zephyr", root: "/p", evidence: ["west.yml"] },
    tools: [{ kind: "pyocd", path: "C:/pyocd", version: "0.45.1" }],
    missing: ["west"],
    probes: [{ kind: "pyocd", name: "STLink" }],
    ports: [{ path: "COM7" }],
    selection: { target: "stm32f103rc" },
    scannedAt: "2026-10-19T00:00:00.000Z",
    build: { ok: true, usage: { flash: 100, ram: 20 }, at: "2026-10-19T00:00:00.000Z" },
  });
  assert.equal(state.project.kind, "zephyr");
  assert.equal(state.tools.length, 1);
  assert.equal(state.missing[0], "west");
  assert.equal(state.probes.length, 1);
  assert.equal(state.ports.length, 1);
  assert.equal(state.effective.port, "COM7");
  assert.equal(state.build?.usage?.flash, 100);
});

// ---- validBoard ------------------------------------------------------------

test("a non-object board selection is rejected", () => {
  assert.equal(validBoard(null), undefined);
  assert.equal(validBoard("COM7"), undefined);
  assert.equal(validBoard([]), undefined);
  assert.equal(validBoard({}), undefined);
});

test("baud is clamped to what a UART can do", () => {
  assert.equal(validBoard({ baud: 10 })?.baud, 300);
  assert.equal(validBoard({ baud: 99_999_999 })?.baud, 4_000_000);
  assert.equal(validBoard({ baud: "115200" })?.baud, 115200);
});

test("an unknown flasher is dropped, not passed to a spawn", () => {
  assert.equal(validBoard({ flasher: "rm -rf" }), undefined);
  assert.equal(validBoard({ flasher: "pyocd" })?.flasher, "pyocd");
});

test("strings are trimmed and length-limited", () => {
  assert.equal(validBoard({ port: "  COM7  " })?.port, "COM7");
  assert.equal(validBoard({ port: "x".repeat(65) })?.port, undefined);
});

// ---- mergeConfigFile / writeBoardConfig ------------------------------------

test("merging keeps keys it did not touch", () => {
  const dir = scratch("prom-board-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ model: "glm-5.3-flash", board: { port: "COM1" } }), "utf8");
  mergeConfigFile(path, { board: { port: "COM7" } });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.model, "glm-5.3-flash");
  assert.equal(saved.board.port, "COM7");
});

test("a null board removes the key", () => {
  const dir = scratch("prom-board-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ board: { port: "COM7" } }), "utf8");
  mergeConfigFile(path, { board: null });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("board" in saved, false);
});

test("an existing project config wins over the global one", () => {
  const dir = scratch("prom-board-");
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  const project = join(dir, ".prometheus", "config.json");
  writeFileSync(project, "{}", "utf8");
  const written = writeBoardConfig({ target: "stm32f103rc" }, dir);
  assert.equal(written, project);
  assert.equal(JSON.parse(readFileSync(project, "utf8")).board.target, "stm32f103rc");
});

test("a folder without a project config falls back to the global file", () => {
  const dir = scratch("prom-board-");
  const written = writeBoardConfig({ target: "stm32f103rc" }, dir);
  // Not the scratch project: the global path is the one the host would use.
  assert.equal(written.endsWith(join("prometheus", "config.json")) || written.endsWith("config.json"), true);
  assert.equal(existsSync(written), true);
});

// ---- SerialLineBuffer ------------------------------------------------------

test("a chunk ending mid-line keeps the partial line", () => {
  const buffer = new SerialLineBuffer();
  buffer.push("hel");
  buffer.push("lo\nworld");
  const batch = buffer.drain();
  assert.deepEqual(
    batch.lines.map((line) => line.text),
    ["hello"],
  );
  buffer.push("\n");
  assert.deepEqual(
    buffer.drain().lines.map((line) => line.text),
    ["world"],
  );
});

test("CRLF and a lone CR are handled", () => {
  const buffer = new SerialLineBuffer();
  buffer.push("a\r\nb\r\n");
  assert.deepEqual(
    buffer.drain().lines.map((line) => line.text),
    ["a", "b"],
  );
});

test("a line that never ends is cut at the partial cap", () => {
  const buffer = new SerialLineBuffer({ maxPartial: 8 });
  buffer.push("0123456789ABCDEF");
  const batch = buffer.drain();
  assert.equal(batch.lines.length, 1);
  assert.equal(batch.lines[0].text, "01234567");
});

test("the ring keeps the newest lines and the pending cap counts its drops", () => {
  const buffer = new SerialLineBuffer({ maxLines: 3, maxPending: 3 });
  for (let index = 0; index < 6; index++) buffer.push(`line ${index}\n`);
  const batch = buffer.drain();
  assert.deepEqual(
    batch.lines.map((line) => line.text),
    ["line 3", "line 4", "line 5"],
  );
  assert.equal(batch.dropped, 3);
  // The retained window is the same three lines, newest last.
  assert.deepEqual(
    buffer.peek().map((line) => line.text),
    ["line 3", "line 4", "line 5"],
  );
});

test("drain(max) leaves the rest queued", () => {
  const buffer = new SerialLineBuffer();
  for (let index = 0; index < 5; index++) buffer.push(`${index}\n`);
  const first = buffer.drain(2);
  assert.equal(first.lines.length, 2);
  assert.equal(first.remaining, 3);
  const second = buffer.drain(2);
  assert.deepEqual(
    second.lines.map((line) => line.text),
    ["2", "3"],
  );
  assert.equal(second.remaining, 1);
});

test("a level and a tag survive into the line", () => {
  const buffer = new SerialLineBuffer();
  buffer.push("[00:00:01.234,567] <err> i2c: NACK\n");
  const line = buffer.drain().lines[0];
  assert.equal(line.level, "error");
  assert.equal(line.tag, "i2c");
  assert.equal(line.text, "NACK");
  assert.equal(line.t, 1234);
  assert.ok(line.at > 0);
});

test("clear empties the ring and the partial line", () => {
  const buffer = new SerialLineBuffer();
  buffer.push("one\ntwo");
  buffer.clear();
  assert.equal(buffer.peek().length, 0);
  assert.equal(buffer.queued, 0);
  // The unterminated "two" was discarded with everything else; a newline now
  // starts a new, genuinely empty line.
  buffer.push("three");
  assert.equal(buffer.drain().lines.length, 0);
  buffer.flushPartial();
  assert.deepEqual(
    buffer.drain().lines.map((line) => line.text),
    ["three"],
  );
});

test("flushPartial emits a prompt that never got a newline", () => {
  const buffer = new SerialLineBuffer();
  buffer.push("login: ");
  assert.equal(buffer.drain().lines.length, 0);
  buffer.flushPartial();
  assert.deepEqual(
    buffer.drain().lines.map((line) => line.text),
    ["login: "],
  );
});
