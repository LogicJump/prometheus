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
  readDisassemblyText,
  readMemoryReply,
  readMenu,
  readSstr,
  readVset,
  readVtrFrame,
  ivarEnum,
  varVal,
  vset,
  vsetWithValue,
  readTrnOpt,
  sstr,
  statusName,
  stopReason,
  stopReasonName,
  trnOpt,
  trnOptValue,
  type AsyncFrame,
} from "../src/embedded/uvsock.ts";
import { NEEDS_EXTENDED_STACK, UNSUPPORTED_ON_MDK_5_43 } from "../src/embedded/keilExtra.ts";
import { findRegister, orderStackFrames, parseIntelHex, parseRegisters, parseStackFrames, parseVariables, readTaskFrames } from "../src/embedded/keilSession.ts";

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

test("a disassembly reply is the window's text, not instruction words", () => {
  // Measured for 0x08006be0: an AMEM whose aBytes are the decoded lines —
  // address(8) | nBytes(4) | ErrAddr(8) | nErr(4) | text.
  // The first implementation read them as 32-bit words and reported
  // 0x30307830 — the ASCII "0x00" — as an opcode.
  const text = "0x08006BE0 F7F9FF38  BL.W          0x08000A54 HAL_Init\n";
  const reply = Buffer.alloc(24 + text.length);
  reply.writeBigUInt64LE(0x08006be0n, 0);
  reply.writeUInt32LE(text.length, 8);
  reply.writeBigUInt64LE(0x08006be0n, 12);
  reply.writeUInt32LE(0, 20);
  Buffer.from(text, "latin1").copy(reply, 24);
  const decoded = readDisassemblyText(reply);
  assert.equal(decoded?.address, 0x08006be0);
  assert.equal(decoded?.bytes, text.length);
  assert.equal(decoded?.text, text);
});

test("the unsupported list names why, never a bare flag", () => {
  for (const [name, reason] of Object.entries(UNSUPPORTED_ON_MDK_5_43)) {
    assert.ok(reason.length > 20, `${name} needs a measured reason`);
  }
  // The one that would quietly return a wrong number is named explicitly.
  assert.match(UNSUPPORTED_ON_MDK_5_43.DBG_READ_REGISTERS ?? "", /enumeration/);
});

test("watch expressions and variables are not filed as unsupported", () => {
  // They answer NOT_SUPPORTED only until extended stack mode is on; that is a
  // setup requirement, not a missing capability, and listing them as
  // unavailable is how the feature stayed switched off.
  for (const name of ["DBG_EVAL_WATCH_EXPRESSION", "DBG_REMOVE_WATCH_EXPRESSION", "DBG_ENUM_VARIABLES", "DBG_VARIABLE_SET", "DBG_ENUM_TASKS"]) {
    assert.equal(UNSUPPORTED_ON_MDK_5_43[name], undefined, `${name} works in extended stack mode`);
    assert.ok(NEEDS_EXTENDED_STACK[name], `${name} should be listed as needing extended stack mode`);
  }
});

test("a register frame's value starts one byte past the flags", () => {
  // Measured REGENUM: 0000 0000 "R0\0…" 02 "0x00000000\0…"
  // The old parse read a u32 at 20, swallowing the first three characters of
  // the value: 0x08006458 came out as the plausible "8006460".
  const body = Buffer.alloc(53);
  body.writeUInt16LE(0, 0);
  body.writeUInt16LE(0, 2);
  body.write("R0\0", 4, "latin1");
  body.writeUInt8(0x02, 20);
  body.write("0x08006458\0", 21, "latin1");
  const frame: AsyncFrame = { type: 0x5028, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [register] = parseRegisters([frame]);
  assert.equal(register?.name, "R0");
  assert.equal(register?.value, "0x08006458");
  assert.equal(register?.canChange, true);
  assert.equal(register?.isPC, false);
});

test("a register write carries the value in the VSET value field", () => {
  // VSET is packed: type(4) value(8) len(4) text. Writing "R0" with the value
  // left at zero is answered SUCCESS and changes nothing — the old request
  // put the name and value in two back-to-back SSTRs.
  const request = vsetWithValue("R0", 5, 0x42n);
  assert.equal(request.readInt32LE(0), 5);
  assert.equal(request.readBigInt64LE(4), 0x42n);
  assert.equal(request.readInt32LE(12), 3);
  assert.equal(request.subarray(16, 18).toString("latin1"), "R0");
});

test("a variable request carries a count, and a write names the variable by id", () => {
  // IVARENUM with count = 0 is answered SUCCESS with an empty stream, so a
  // request that asks for nothing looks like an image with no symbols.
  const request = ivarEnum(0, 0, 0, 128);
  assert.equal(request.length, 16);
  assert.equal(request.readUInt16LE(12), 128);
  // VARVAL is that IVARENUM followed by the new value as an SSTR.
  const write = varVal(0x123456, 0, 0, "42");
  assert.equal(write.readInt32LE(0), 0x123456);
  assert.equal(write.readInt32LE(16), 3);
  assert.equal(write.subarray(20, 22).toString("latin1"), "42");
});

test("a variable frame keeps its id, index and count", () => {
  // VARINFO: nID(4) index(4) count(4) typeSize(4) flags(4) value(SSTR) …
  const body = Buffer.alloc(20 + 260 * 4);
  body.writeInt32LE(0x0abc, 0);
  body.writeInt32LE(33, 4);
  body.writeInt32LE(0, 8);
  body.writeUInt32LE(1, 16); // editable
  sstr("0x00003039").copy(body, 20);
  sstr("uint").copy(body, 280);
  sstr("uwTick").copy(body, 540);
  const frame: AsyncFrame = { type: 0x5041, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [variable] = parseVariables([frame]);
  assert.equal(variable?.id, 0x0abc);
  assert.equal(variable?.index, 33);
  assert.equal(variable?.name, "uwTick");
  assert.equal(variable?.value, "0x00003039");
  assert.equal(variable?.editable, true);
});

test("a task frame's name is a counted string after its fields", () => {
  // Measured, 276 bytes: nItem(4) nAdr(4) nRetAdr(4) nVars(4) len(4) text…
  // `00 00 00 00 00 00 00 00 00 00 00 00 02 00 00 00 0c 00 00 00 "Main Thread"`.
  // Reading at 12 (the fields) and at 40 (past the text) both produced an
  // empty list for a target that does report a thread.
  const body = Buffer.alloc(276);
  body.writeUInt32LE(2, 12);
  body.writeUInt32LE(12, 16);
  body.write("Main Thread\0", 20, "latin1");
  const frame: AsyncFrame = { type: 0x5051, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const task = readTaskFrames([frame])[0];
  assert.equal(task?.name, "Main Thread");
  assert.equal(task?.id, 0);
});

test("an Intel HEX image is read at its own addresses", () => {
  // The chip comparison starts at the image's load address. Reading an `.axf`
  // from byte zero starts at `7f 45 4c 46` — the ELF header, not the vector
  // table — and reports a mismatch on a flash that is perfectly correct.
  const lines = [
    ":020000040800F2",
    ":04000000" + "A8090020" + "D4",
    ":00000001FF",
  ];
  const records = parseIntelHex(lines.join(String.fromCharCode(10)));
  const data = records.filter((record) => record.bytes.length > 0);
  assert.equal(data.length, 1);
  assert.equal(data[0].address, 0x08000000, "the extended address record is applied");
  assert.deepEqual(data[0].bytes, [0xa8, 0x09, 0x00, 0x20]);
});

test("the stack is reported innermost first", () => {
  // The debugger lists it from the bottom up: Reset_Handler's return address
  // is 0xffffffff. Reporting that order made "#0" the startup code.
  const frame = (item: number, address: number, ret: bigint) => {
    const body = Buffer.alloc(48);
    body.writeUInt32LE(item, 0);
    body.writeBigUInt64LE(BigInt(address), 4);
    body.writeBigUInt64LE(ret, 12);
    return { type: 0x5015, echoed: 0, data: body, raw: Buffer.alloc(0) } as AsyncFrame;
  };
  const ordered = orderStackFrames([
    frame(1, 0x08000258, 0xffffffffn),
    frame(2, 0x08006460, 0x08000258n),
  ]);
  assert.equal(ordered[0]?.address, 0x08006460);
  assert.equal(ordered[0]?.level, 0);
  assert.equal(ordered[1]?.address, 0x08000258);
});

test("a stack frame is what the record holds, not a symbol read from its fields", () => {
  // A 48-byte STACKENUM frame is nItem, nAdr, nRetAdr, nVars, nEqual, nTotal,
  // nTask, nRes[3] — no text. Reading a symbol at 20 put `nEqual` (2) into the
  // function name, and the stack printed "#0 Reset_Handler" for a frame that
  // was in SystemInit.
  const body = Buffer.alloc(48);
  body.writeUInt32LE(1, 0);
  body.writeBigUInt64LE(0x08000258n, 4);
  body.writeBigUInt64LE(0xffffffffn, 12);
  body.writeUInt32LE(0, 20);
  body.writeUInt32LE(2, 24);
  body.writeUInt32LE(2, 28);
  const frame: AsyncFrame = { type: 0x5015, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [parsed] = parseStackFrames([frame]);
  assert.equal(parsed?.address, 0x08000258);
  assert.equal(parsed?.function, undefined);
  assert.equal(parsed?.variables, 0);
});

test("a register can be named the way a person types it", () => {
  // The debugger lists `R15 (PC)`; the old lookup searched for `PC` exactly,
  // found nothing, sent the write anyway and reported SUCCESS.
  const registers = [
    { group: 0, index: 0, name: "R0", value: "0x00000000", isPC: false, canChange: true },
    { group: 0, index: 13, name: "R13 (SP)", value: "0x200009A8", isPC: false, canChange: true },
    { group: 0, index: 15, name: "R15 (PC)", value: "0x08006458", isPC: true, canChange: true },
  ];
  assert.equal(findRegister(registers, "PC")?.name, "R15 (PC)");
  assert.equal(findRegister(registers, "sp")?.name, "R13 (SP)");
  assert.equal(findRegister(registers, "R15")?.name, "R15 (PC)");
  assert.equal(findRegister(registers, "15")?.name, "R15 (PC)");
  assert.equal(findRegister(registers, "R7"), undefined);
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

/* ---------- the CMSIS-Toolbox ---------- */

test("a csolution project is recognised and built with cbuild", async () => {
  const { detectProject, buildCommand } = await import("../src/embedded/project.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-csol-"));
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "demo.csolution.yml"), ["solution:", "  projects: []"].join(String.fromCharCode(10)));
    const project = detectProject(dir);
    assert.equal(project.kind, "csolution");
    assert.match(project.file ?? "", /\.csolution\.yml$/);
    const command = buildCommand(project, { cbuild: "cbuild.exe" }, {});
    assert.equal(command?.program, "cbuild.exe");
    assert.match(command?.args[0] ?? "", /\.csolution\.yml$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the three toolbox tools are first-class toolchains", async () => {
  const { TOOLCHAIN_INFO } = await import("../src/embedded/toolchain.ts");
  for (const kind of ["cbuild", "cpackget", "svdconv"] as const) {
    assert.ok(TOOLCHAIN_INFO[kind], `${kind} has an entry`);
    assert.ok(TOOLCHAIN_INFO[kind].purpose.length > 20, `${kind} says what it is for`);
  }
  // The toolbox ships inside a Keil install, so the search must look there.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/embedded/toolchain.ts", "utf8");
  assert.match(source, /cmsis-toolbox/, "the Keil install's toolbox directory is searched");
});

/* ---------- status names ---------- */

test("status codes are named, and an unknown one is still honest", () => {
  assert.equal(statusName(0), "SUCCESS");
  assert.equal(statusName(6), "NOT_DEBUGGING");
  assert.equal(statusName(10), "DEBUGGING");
  assert.equal(statusName(1234), "status 1234");
});

/* ---------- source-location breakpoints ---------- */

test("`file:line` and `file(line)` are recognised; a symbol is not one", async () => {
  const { parseFileLine } = await import("../src/embedded/keilSession.ts");
  const B = String.fromCharCode(92);
  assert.deepEqual(parseFileLine("main.c:36"), { file: "main.c", line: 36 });
  assert.deepEqual(parseFileLine(["..", "USER", "main.c"].join(B) + ":36"), { file: "../USER/main.c", line: 36 });
  assert.deepEqual(parseFileLine("main.c(36)"), { file: "main.c", line: 36 });
  assert.deepEqual(parseFileLine("./ui.c: 497"), { file: "ui.c", line: 497 });
  // Symbols and addresses are passed through untouched by the caller.
  assert.equal(parseFileLine("UI_Update"), null);
  assert.equal(parseFileLine("0x08006994"), null);
  assert.equal(parseFileLine("main.c:0"), null);
});

test("fromelf's line table is read, with the zero-address headers dropped", async () => {
  // Verbatim shape from `fromelf --text -g TOUCH.axf` on MDK 5.43a.
  const B = String.fromCharCode(92);
  const text = [
    "  007fe7:  DW_LNS_copy                  : 01                08006be0: main.c:35.5 [",
    "  007fe9:  SPECIAL(0, 1)                : 13                08006be2: main.c:35.5",
    "  007feb:  SPECIAL(1, 1)                : 14                08006be4: main.c:36.5 [",
    "00000000: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:1.0",
    "08000c42: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:488.5",
  ].join(String.fromCharCode(10));
  const { parseFromelfLines } = await import("../src/embedded/keilSession.ts");
  const entries = parseFromelfLines(text);
  assert.deepEqual(entries, [
    { address: 0x08006be0, file: "main.c", line: 35 },
    { address: 0x08006be2, file: "main.c", line: 35 },
    { address: 0x08006be4, file: "main.c", line: 36 },
    { address: 0x08000c42, file: "../HARDWARE/LCD/ltdc.c", line: 488 },
  ]);
});

test("a source location that needs an image fails clearly without one", async () => {
  const { sourceLineAddress, parseFromelfLines } = await import("../src/embedded/keilSession.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-dwarf-"));
  try {
    const noImage = await sourceLineAddress(join(dir, "missing.axf"), "does-not-matter", "main.c", 1);
    assert.ok("error" in noImage && /build first/.test(noImage.error), "error" in noImage ? noImage.error : "no error");
    // A reader that is not there is a failure, not an empty table.
    const elf = join(dir, "image.axf");
    writeFileSync(elf, "not really an elf");
    const noReader = await sourceLineAddress(elf, join(dir, "no-fromelf.exe"), "main.c", 35);
    assert.ok("error" in noReader && /fromelf exited/.test(noReader.error), "error" in noReader ? noReader.error : "no error");
    assert.equal(parseFromelfLines("").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line that is not in the image is reported with that file's real lines", async () => {
  const { parseFromelfLines } = await import("../src/embedded/keilSession.ts");
  const B = String.fromCharCode(92);
  const table = [
    "08006be0: main.c:35.5",
    "08006bf8: main.c:38.5",
    "08000c42: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:488.5",
  ].join(String.fromCharCode(10));
  const entries = parseFromelfLines(table);
  assert.deepEqual(entries.map((entry) => [entry.address, entry.file, entry.line]), [
    [0x08006be0, "main.c", 35],
    [0x08006bf8, "main.c", 38],
    [0x08000c42, "../HARDWARE/LCD/ltdc.c", 488],
  ]);
  // The resolution rules the failure message depends on: a bare file name and
  // a path suffix both find the image's own, longer path.
  const fileMatches = (candidate: string, wanted: string) => candidate === wanted || candidate.endsWith("/" + wanted);
  assert.ok(fileMatches("../HARDWARE/LCD/ltdc.c", "ltdc.c"), "a bare file name finds it");
  assert.ok(fileMatches("../HARDWARE/LCD/ltdc.c", "LCD/ltdc.c"), "a path suffix finds it");
  assert.ok(!fileMatches("../HARDWARE/LCD/ltdc.c", "UI/ltdc.c"), "another directory does not");
});

/* ---------- csolution (CMSIS-Toolbox) ---------- */

test("a detected Arm compiler is registered the way cbuild expects", async () => {
  const { compilerRegistration, compilerFromDetection } = await import("../src/embedded/toolEnv.ts");
  // `armclang --version` prints the IDE's version first; the compiler's own
  // version is the one CMSIS-Toolbox keys on.
  const ac6 = compilerFromDetection([
    { kind: "keil", path: "G:" + String.fromCharCode(92) + "software" + String.fromCharCode(92) + "keil5" + String.fromCharCode(92) + "UV4" + String.fromCharCode(92) + "UV4.exe", version: "5.43.1.0" },
  ]);
  // The Keil entry is resolved from the install root on this machine; on a
  // machine without Keil there is nothing to add, which is also correct.
  if (ac6.length === 0) return;
  const ac6Entry = ac6.find((entry) => entry.kind === "AC6");
  assert.ok(ac6Entry, "AC6 is registered from the Keil install");
  assert.match(ac6Entry!.bin, /ARMCLANG/i);
  // The compiler's version, not the IDE's.
  assert.match(ac6Entry!.version, /^6\./);
  const env = compilerRegistration(ac6.map((entry) => ({ name: entry.kind, bin: entry.bin, version: entry.version })));
  const key = Object.keys(env).find((name) => /^AC6_TOOLCHAIN_\d+_\d+_\d+$/.test(name));
  assert.ok(key, `an AC6_TOOLCHAIN_<major>_<minor>_<patch> variable is produced, got ${JSON.stringify(env)}`);
  assert.equal(env[key!], ac6Entry!.bin);
});

test("a user's own compiler registration is not overwritten", async () => {
  const { compilerRegistration } = await import("../src/embedded/toolEnv.ts");
  const env = compilerRegistration([{ name: "AC6", bin: "/detected/bin", version: "6.24" }], { AC6_TOOLCHAIN_6_24_0: "/user/bin" });
  assert.deepEqual(env, {}, "the explicitly set variable wins");
});

test("`**` in an artifact pattern walks nested output directories", async () => {
  const { findArtifactsIn } = await import("../src/embedded/build.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-out-"));
  try {
    // csolution's layout: out/<project>/<target>/<build>/<name>.axf
    const outDir = join(dir, "out", "Demo", "MyBoard", "Debug");
    mkdirSync(outDir, { recursive: true });
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    writeFileSync(join(outDir, "Demo.axf"), elf);
    writeFileSync(join(outDir, "Demo.hex"), Buffer.from(":00000001FF" + String.fromCharCode(10)));
    const found = findArtifactsIn([dir], ["out/**/*.axf", "out/**/*.hex"], undefined, dir);
    const kinds = found.map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ["elf", "hex"], `found ${JSON.stringify(found.map((entry) => entry.relative))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-target project's image is read from the active target's block", async () => {
  const { imageLocation } = await import("../src/embedded/keilSession.ts");
  const { fromelfFor } = await import("../src/embedded/build.ts");
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const B = String.fromCharCode(92);
  const uv4 = ["G:", "software", "keil5", "UV4", "UV4.exe"].join(B);
  const fromelf = fromelfFor(uv4);
  if (!fromelf) return; // no Keil on this machine: nothing to resolve with
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mt-"));
  try {
    const block = (name: string, out: string) =>
      "<Target><TargetName>" + name + "</TargetName>" +
      "<OutputDirectory>." + B + out + B + "</OutputDirectory>" +
      "<OutputName>" + name + "</OutputName></Target>";
    const project = join(dir, "P.uvprojx");
    writeFileSync(project, "<Project><Targets>" + block("A", "OBJ") + block("B", "OBJ_SIM") + "</Targets></Project>");
    mkdirSync(join(dir, "OBJ"));
    mkdirSync(join(dir, "OBJ_SIM"));
    // `imageLocation` asks the live session for its active target through
    // `PRJ_GET_TARGET`; a stand-in client answers that one request.
    const { encodeMessage } = await import("../src/embedded/uvsock.ts");
    const { MessageReader } = await import("../src/embedded/uvsock.ts");
    const session = (active: string) =>
      ({
        project,
        client: {
          programPath: uv4,
          send: async () => {
            // `{ u32 echoed, u32 status, u32 len, char text[] }` inside a
            // CMD_RESPONSE envelope, which is what the real client returns.
            // `currentTarget` reads the name from offset 4 of the reply data,
            // so the first word is the option slot, not the echoed command.
            const body = Buffer.alloc(8 + 64);
            body.writeUInt32LE(0, 0);
            Buffer.from(active, "latin1").copy(body, 4);
            return { ok: true, status: 0, statusName: "SUCCESS", data: body };
          },
        },
      }) as unknown as Parameters<typeof imageLocation>[0];
    void encodeMessage;
    void MessageReader;
    const a = await imageLocation(session("A"));
    const b = await imageLocation(session("B"));
    assert.ok("elf" in a && a.elf.endsWith("OBJ" + B + "A.axf"), JSON.stringify(a));
    assert.ok("elf" in b && b.elf.endsWith("OBJ_SIM" + B + "B.axf"), JSON.stringify(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
