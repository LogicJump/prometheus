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
  readMemoryReply,
  readSstr,
  readTrnOpt,
  sstr,
  statusName,
  stopReason,
  stopReasonName,
  trnOpt,
  trnOptValue,
  type AsyncFrame,
} from "../src/embedded/uvsock.ts";

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

/* ---------- status names ---------- */

test("status codes are named, and an unknown one is still honest", () => {
  assert.equal(statusName(0), "SUCCESS");
  assert.equal(statusName(6), "NOT_DEBUGGING");
  assert.equal(statusName(10), "DEBUGGING");
  assert.equal(statusName(1234), "status 1234");
});
