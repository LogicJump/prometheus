/**
 * Persistent debug sessions and memory access.
 *
 * `embed_debug` used to be one call, one action: attach, do one thing, exit.
 * That is not how debugging works — the loop is "stop here, look at the value,
 * change the source, rebuild, look again", and every call re-attached and lost
 * every breakpoint. A session that survives between tool calls is what makes
 * the loop possible without the model re-doing the attach each time.
 *
 * Named by target + remote endpoint, so a second `embed_debug` with the same
 * arguments continues the same session rather than starting a second GDB.
 */

import type { ChildProcess } from "node:child_process";
import { MiSession, type MiRecord } from "./debug.ts";
import { killTree } from "../winsandbox.ts";

export interface DebugHandle {
  key: string;
  session: MiSession;
  server?: ChildProcess;
  remote: string;
  /** Events collected since the last action, so a stop can be described. */
  events: MiRecord[];
  openedAt: number;
}

const sessions = new Map<string, DebugHandle>();

/** The key a session is stored under: the endpoint plus the target. */
export function sessionKey(remote: string, target: string | undefined, elf: string): string {
  return `${remote}|${target ?? ""}|${elf}`;
}

export function getSession(key: string): DebugHandle | undefined {
  return sessions.get(key);
}

export function putSession(handle: DebugHandle): void {
  sessions.set(handle.key, handle);
}

/** Close one session: terminate its server and drop the handle. */
export function closeSession(key: string): boolean {
  const handle = sessions.get(key);
  if (!handle) return false;
  try {
    handle.session.close?.();
  } catch {
    /* the GDB process may already be gone */
  }
  try {
    if (handle.server?.pid) killTree(handle.server.pid);
    else handle.server?.kill();
  } catch {
    /* same */
  }
  sessions.delete(key);
  return true;
}

/** Every open session, for a tool that lists them. */
export function listSessions(): { key: string; remote: string; openedAt: number }[] {
  return [...sessions.values()].map((handle) => ({ key: handle.key, remote: handle.remote, openedAt: handle.openedAt }));
}

/** Close everything (process exit, host shutdown). */
export function closeAll(): void {
  for (const key of [...sessions.keys()]) closeSession(key);
}

/**
 * Read a block of memory through the session.
 *
 * GDB's `-data-read-memory-bytes <addr> <count>` returns hex; count is bytes.
 */
export async function readMemory(session: MiSession, address: number, length: number): Promise<number[] | null> {
  const result = await session.send(`-data-read-memory-bytes 0x${address.toString(16)} ${length}`);
  if (!result.ok) return null;
  const match = /contents="([0-9a-fA-F]+)"/.exec(result.body);
  if (!match) return null;
  const bytes: number[] = [];
  for (let index = 0; index + 2 <= match[1].length; index += 2) {
    const value = Number.parseInt(match[1].slice(index, index + 2), 16);
    if (Number.isFinite(value)) bytes.push(value);
  }
  return bytes.length > 0 ? bytes : null;
}

/**
 * Write bytes and read them back.
 *
 * The read-back is not paranoia: a write to a read-only region, a peripheral
 * that masks bits, or a cached address can all accept the command and store
 * something else. Reporting the value that is actually there is the only
 * honest answer to "I set it".
 */
export async function writeMemory(
  session: MiSession,
  address: number,
  bytes: number[],
): Promise<{ ok: boolean; readBack: number[] | null; detail: string }> {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const result = await session.send(`-data-write-memory-bytes 0x${address.toString(16)} ${hex}`);
  if (!result.ok) return { ok: false, readBack: null, detail: result.body || "the write was refused" };
  const readBack = await readMemory(session, address, bytes.length);
  const matches = readBack !== null && readBack.every((byte, index) => byte === bytes[index]);
  return {
    ok: true,
    readBack,
    detail: matches
      ? `wrote ${bytes.length} byte(s) and read them back`
      : `wrote ${bytes.length} byte(s) but the read-back differs (the region may be read-only or mask bits)`,
  };
}

/** Decode bytes according to a width name. */
export function decodeValue(bytes: number[], width: "u8" | "u16" | "u32"): number {
  let value = 0;
  const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
  for (let index = 0; index < Math.min(size, bytes.length); index++) value += bytes[index] * 2 ** (8 * index);
  // `u32` can exceed 2^31; keep it unsigned rather than letting `+` produce a
  // float, which is what a naive byte loop does above 2 GB.
  return width === "u32" ? value >>> 0 : value;
}

/** Encode a value into little-endian bytes for a write. */
export function encodeValue(value: number, width: "u8" | "u16" | "u32"): number[] {
  const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
  const bytes: number[] = [];
  let rest = value >>> 0;
  for (let index = 0; index < size; index++) {
    bytes.push(rest & 0xff);
    rest = rest >>> 8;
  }
  return bytes;
}
