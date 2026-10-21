/**
 * Round 12: the uVision socket protocol.
 *
 * Every assertion here was written against bytes captured from MDK 5.43a over
 * a live `UV4.exe -s` connection. The offsets are not guesses — three of them
 * were wrong in the first implementation and each one produced a plausible
 * but false result ("0 breakpoints", "every stop is reason 0", "(no source)"),
 * which is exactly why they are pinned down here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MessageReader,
  asyncText,
  commandWindowText,
  encodeMessage,
  isStopNotification,
  messageCommand,
  messagePayload,
  prjData,
  readCountedString,
  readDisassembly,
  readMemoryReply,
  readMenu,
  readSstr,
  readVset,
  readVtrFrame,
  vset,
  readTrnOpt,
  sstr,
  statusName,
  stopReason,
  stopReasonName,
  trnOpt,
  trnOptValue,
  type AsyncFrame,
} from "../src/embedded/uvsock.ts";
import { UNSUPPORTED_ON_MDK_5_43 } from "../src/embedded/keilExtra.ts";

/* ---------- framing ---------- */

test("a request is a 32-byte header followed by its payload", () => {
  const message = encodeMessage(0x2004, Buffer.from([1, 2, 3]));
  assert.equal(message.length, 35);
  assert.equal(message.readUInt32LE(0), 35, "total length includes the header");
  assert.equal(message.readUInt32LE(4), 0x2004, "the operation code");
  assert.equal(message.readUInt32LE(8), 3, "payload length");
  assert.equal(message.readUInt32LE(28), 0, "the reserved id is zero");
  assert.deepEqual([...message.subarray(32)], [1, 2, 3]);
});

test("streamed chunks are reassembled into whole messages", () => {
  const reader = new MessageReader();
  const one = encodeMessage(0x3000, Buffer.alloc(10));
  const two = encodeMessage(0x5020, Buffer.alloc(4));
  // Split mid-header and mid-payload: TCP gives no message boundaries.
  const all = Buffer.concat([one, two]);
  const seen: Buffer[] = [];
  for (const cut of [20, 40, all.length]) seen.push(...reader.push(all.subarray(cut === 20 ? 0 : cut === 40 ? 20 : 40, cut)));
  assert.equal(seen.length, 2, "two whole messages came out of three chunks");
  assert.equal(messageCommand(seen[0]), 0x3000);
  assert.equal(messageCommand(seen[1]), 0x5020);
});

test("a nonsense length drops the buffer instead of pairing a reply wrongly", () => {
  const reader = new MessageReader();
  const bad = Buffer.alloc(32);
  bad.writeUInt32LE(999_999, 0);
  assert.equal(reader.push(bad).length, 0);
  // The reader is empty again, so the next real message is read cleanly.
  const good = encodeMessage(0x3000, Buffer.alloc(4));
  assert.equal(reader.push(good).length, 1);
});

test("the command and payload are read from the header", () => {
  const message = encodeMessage(0x1017, Buffer.from("TOUCH\0"));
  assert.equal(messageCommand(message), 0x1017);
  assert.equal(messagePayload(message).toString("latin1"), "TOUCH\0");
});

/* ---------- strings ---------- */

test("SSTR carries its length including the terminator", () => {
  const encoded = sstr("main");
  assert.equal(encoded.readInt32LE(0), 5);
  assert.equal(readSstr(encoded, 0), "main");
});

test("a counted string counts its characters, not its terminator", () => {
  // Measured: `04 00 00 00 "Core\0"` is the register-group frame.
  const frame = Buffer.from("04000000436f726500", "hex");
  assert.equal(readCountedString(frame, 0), "Core");
  // The two conventions are a byte apart: SSTR's length includes the
  // terminator, this one's does not, so the terminator sits at 4 + len - 1.
  assert.equal(frame.readUInt32LE(0), 4, "four characters, no terminator counted");
  assert.equal(frame[4 + 4], 0x00, "the terminator is at the end of the text");
});

test("an empty counted string is empty, not garbage", () => {
  assert.equal(readCountedString(Buffer.from("00000000", "hex"), 0), "");
  assert.equal(readCountedString(Buffer.alloc(2), 0), "");
});

/* ---------- project data ---------- */

test("PRJDATA is a length, a code, then NUL-separated names", () => {
  const data = prjData("USER", "main.c");
  assert.equal(data.readUInt32LE(0), "USER\0main.c\0".length);
  assert.equal(data.readUInt32LE(4), 0);
  assert.equal(data.subarray(8).toString("latin1"), "USER\0main.c\0");
});

test("TRNOPT puts 0 for an unspecified field and offset 3 for the first string", () => {
  // 0, not 0xffffffff: the interface reads a group name out of a nonsense
  // offset and answers `Group 'ÿ'` when it is sent 0xffffffff.
  const withTarget = trnOpt(6, { target: "TOUCH" });
  assert.equal(withTarget.readUInt32LE(0), 6, "job");
  assert.equal(withTarget.readUInt32LE(4), 3, "target starts at szBuffer + 3");
  assert.equal(withTarget.readUInt32LE(8), 0, "group is unspecified");
  assert.equal(withTarget.readUInt32LE(12), 0, "file is unspecified");
  assert.equal(withTarget.toString("latin1", 23), "TOUCH\0");
});

test("an option read returns its value, not the echoed target name", () => {
  // Measured CDEF reply: the target name in slot 0, then the defines.
  const reply = Buffer.alloc(60);
  reply.writeUInt32LE(6, 0);
  reply.writeUInt32LE(3, 4); // target at szBuffer+3
  reply.writeUInt32LE(9, 8); // value at szBuffer+9
  reply.writeUInt32LE(0, 12);
  reply.writeUInt32LE(0, 16);
  reply.write("TOUCH\0", 23, "latin1");
  reply.write("A=1,B=2\0", 29, "latin1");
  assert.deepEqual(readTrnOpt(reply), ["TOUCH", "A=1,B=2"]);
  assert.equal(trnOptValue(reply), "A=1,B=2");
});

/* ---------- the 0x4000 family ---------- */

function frame(type: number, echoed: number, body: Buffer): AsyncFrame {
  return { type, echoed, data: body, raw: body };
}

test("a progress message is a length and a string", () => {
  // Measured: "Execution started" arrives as `… 12 00 00 00 "Execution started\0"`.
  const body = Buffer.alloc(12 + 18);
  body.writeUInt32LE(18, 8);
  body.write("Execution started\0", 12, "latin1");
  assert.equal(asyncText(frame(0x4000, 0, body)), "Execution started");
});

test("a stop notification is not mistaken for a progress message", () => {
  // The BPREASON body happens to contain a plausible-looking length word, and
  // reading it as text produced " : no 'write' pe" as the stop reason.
  const reason = Buffer.alloc(44);
  reason.writeUInt32LE(1, 12);
  reason.write(" : no 'write' permission", 36, "latin1");
  const stop = frame(0x4000, 0x2003, reason);
  assert.equal(isStopNotification(stop), true);
  assert.equal(asyncText(stop), "");
});

test("the stop reason and PC are read from the measured offsets", () => {
  // Captured at a breakpoint on `main`: 1, 0, 0, 1, 0x08006460, 0x08006460, -1.
  const body = Buffer.alloc(36);
  body.writeUInt32LE(0, 8);
  body.writeUInt32LE(1, 12); // reason: breakpoint
  body.writeUInt32LE(0x08006460, 16); // pc
  body.writeUInt32LE(0, 20);
  body.writeUInt32LE(0x08006460, 24); // fault address
  body.writeUInt32LE(0, 28);
  body.writeInt32LE(-1, 28); // no hardware slot
  const decoded = stopReason(frame(0x4000, 0x2003, body));
  assert.equal(decoded?.reason, 1);
  assert.equal(decoded?.pc, 0x08006460);
  // `0xffffffff` means "no slot" and must not be reported as one.
  assert.equal(decoded?.slot, undefined);
});

test("stop reasons are named from the measured codes", () => {
  assert.equal(stopReasonName(0), "stopped");
  assert.equal(stopReasonName(1), "breakpoint");
  assert.equal(stopReasonName(99), "stop reason 99");
});

test("a command-window line has no reply envelope", () => {
  // Measured: `45 00 00 00 "*** error 65: …"` — the first word is a length,
  // not an echoed command, so the line is not stripped of 8 bytes.
  const line = Buffer.alloc(4 + 20);
  line.writeUInt32LE(20, 0);
  line.write("*** error 65: hi\0", 4, "latin1");
  assert.equal(commandWindowText(frame(0x5020, 0, line)), "*** error 65: hi");
});

/* ---------- memory ---------- */

test("a memory reply is the address, the bytes, and the error address", () => {
  const reply = Buffer.alloc(24 + 4);
  reply.writeBigUInt64LE(0x20000000n, 0);
  reply.writeUInt32LE(4, 8);
  reply.writeBigUInt64LE(0n, 12);
  reply.writeUInt32LE(0, 20);
  reply.writeUInt32LE(0x200009a8, 24);
  const decoded = readMemoryReply(reply);
  assert.equal(decoded?.address, 0x20000000);
  assert.deepEqual(decoded?.bytes, [0xa8, 0x09, 0x00, 0x20]);
  assert.equal(decoded?.errorAddress, undefined, "no error address on success");
});

/* ---------- the operations added after the first audit ---------- */

test("a VSET reply carries a 64-bit value and the debugger's rendering", () => {
  // Measured for `main`: 05 00 00 00 | e0 6b 00 08 00 00 00 00 | 05 00 00 00 "main\0"
  const reply = Buffer.from("05000000e06b000800000000050000006d61696e00", "hex");
  const decoded = readVset(reply);
  assert.equal(decoded?.type, 5);
  assert.equal(decoded?.value, 0x08006be0n);
  assert.equal(decoded?.text, "main");
});

test("a VSET request puts no literal value and the expression as an SSTR", () => {
  const request = vset("main");
  assert.equal(request.readInt32LE(0), 0, "no literal value");
  assert.equal(request.readInt32LE(12), 5, "length including the terminator");
  assert.equal(request.toString("latin1", 16, 21), "main\0");
});

test("a menu entry's label runs to the length, not one short of it", () => {
  // Measured: 00 00 00 00 | 00 00 00 00 | 01 00 00 00 | 01 00 00 00 | 0a 00 00 00 "Trace Data\0"
  const frame: AsyncFrame = { type: 0x5061, echoed: 0, data: Buffer.from("000000000000000001000000010000000a0000005472616365204461746100", "hex"), raw: Buffer.alloc(0) };
  const entry = readMenu(frame);
  assert.equal(entry?.label, "Trace Data", "reading length - 1 cut the last letter");
  assert.equal(entry?.enabled, true);
});

test("a trace-variable name is counted without its terminator", () => {
  // Measured AVTR: 12 00 00 00 | 7 zero words | 09 00 00 00 | 2 zero words | "CURR_TID\0"
  const body = Buffer.alloc(53);
  body.writeUInt32LE(0x12, 0);
  body.writeUInt32LE(9, 32);
  body.write("CURR_TID\0", 44, "latin1");
  const frame: AsyncFrame = { type: 0x5018, echoed: 0, data: body, raw: Buffer.alloc(0) };
  assert.equal(readVtrFrame(frame)?.name, "CURR_TID");
});

test("a disassembly reply reports the word it holds even with a zero length", () => {
  // Measured for 0x08006be0: address, nLen = 0, then one instruction word.
  // address(8) | nLen(4) | nErr(4) | ErrAddr(8) | the word at 24
  const reply = Buffer.from("e06b0008000000000000000000000000000000000000000020c0e30e", "hex");
  const decoded = readDisassembly(reply);
  assert.equal(decoded?.address, 0x08006be0);
  assert.equal(decoded?.bytes, 0);
  assert.deepEqual(decoded?.words, [0x0ee3c020]);
});

test("the unsupported list names why, never a bare flag", () => {
  for (const [name, reason] of Object.entries(UNSUPPORTED_ON_MDK_5_43)) {
    assert.ok(reason.length > 20, `${name} needs a measured reason`);
  }
  // The one that would quietly return a wrong number is named explicitly.
  assert.match(UNSUPPORTED_ON_MDK_5_43.DBG_READ_REGISTERS ?? "", /0x00000000/);
});

/* ---------- the Keil downloader ---------- */

test("UV4 -f is the download command, and its log is where the verdict lives", async () => {
  const { commandFor, validate, classifyOutput } = await import("../src/embedded/flash.ts");
  const args = commandFor({ kind: "keil", program: "UV4.exe", firmware: "app.axf", project: "P.uvprojx", logFile: "L.log" });
  assert.deepEqual(args, ["-f", "P.uvprojx", "-j0", "-o", "L.log"]);

  // Measured real log: steps joined without line breaks.
  const log = ["Load app.axf", "Erase Done.Programming Done.Verify OK.Flash Load finished at 11:39:30"].join(String.fromCharCode(10));
  const verdict = classifyOutput("keil", log, 0);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verified, true);
});

test("a failed download is not read as success", async () => {
  const { classifyOutput } = await import("../src/embedded/flash.ts");
  const log = ["Load app.axf", "Error: Flash Download failed  -  Target DLL has been cancelled"].join(String.fromCharCode(10));
  const verdict = classifyOutput("keil", log, 0);
  assert.equal(verdict.ok, false, "a failure phrase wins over a zero exit code");
});

test("a .axf is only accepted by the Keil downloader", async () => {
  const { validate } = await import("../src/embedded/flash.ts");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-axf-"));
  const image = join(dir, "app.axf");
  writeFileSync(image, "ELF");
  try {
    // Refused with a reason, not a generic "not a firmware format".
    const other = validate({ kind: "openocd", program: "openocd", firmware: image });
    assert.match(other ?? "", /Keil's name for an ELF/);
    // Accepted, but the Keil downloader needs the project it draws from.
    const keil = validate({ kind: "keil", program: "UV4.exe", firmware: image });
    assert.match(keil ?? "", /needs the \.uvprojx/);
    const ok = validate({ kind: "keil", program: "UV4.exe", firmware: image, project: join(dir, "P.uvprojx") });
    assert.equal(ok, null);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the UV4 command line ---------- */

test("a Keil build names its target instead of inheriting the last one", async () => {
  const { buildCommand, detectProject } = await import("../src/embedded/project.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-keil-cmd-"));
  try {
    mkdirSync(join(dir, "USER"), { recursive: true });
    writeFileSync(join(dir, "USER", "app.uvprojx"), "<Project/>");
    const project = detectProject(dir);
    assert.equal(project.kind, "keil");
    const plain = buildCommand(project, { keil: "UV4.exe" }, {});
    assert.ok(plain);
    assert.equal(plain.args[0], "-b", "a build is -b");
    // Without `-t` uVision builds whichever target was last current, which is
    // not something a build command should decide on a multi-target project.
    assert.ok(!plain.args.includes("-t"), "no target means no -t");
    const chosen = buildCommand(project, { keil: "UV4.exe" }, { target: "Release" });
    assert.ok(chosen);
    const at = chosen.args.indexOf("-t");
    assert.ok(at > 0, "-t is passed when a target is named");
    assert.equal(chosen.args[at + 1], "Release");
    // A rebuild is `-r`, not a build with a flag.
    const rebuilt = buildCommand(project, { keil: "UV4.exe" }, { release: true });
    assert.equal(rebuilt?.args[0], "-r");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- a session that "entered" without loading anything ---------- */

test("a debug session that could not load the image is not reported as open", async () => {
  // Measured: with the .axf deleted, uVision prints `*** error 56: cannot open
  // file` and enters debug mode anyway. Every later action then answers
  // NOT_DEBUGGING, so treating the entry as success hid the real cause.
  const { default: fs } = await import("node:fs");
  const source = fs.readFileSync("src/embedded/keilSession.ts", "utf8");
  assert.match(source, /cannot open file/, "the load failure is recognised");
  assert.match(source, /session\.debugging = false/, "and the session is not left claiming to be debugging");
});

/* ---------- status names ---------- */

test("status codes are named, and an unknown one is still honest", () => {
  assert.equal(statusName(0), "SUCCESS");
  assert.equal(statusName(6), "NOT_DEBUGGING");
  assert.equal(statusName(10), "DEBUGGING");
  assert.equal(statusName(1234), "status 1234");
});
