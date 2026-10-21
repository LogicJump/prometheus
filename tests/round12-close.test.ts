/**
 * What the debugger is left holding when a session closes.
 *
 * `closeKeilSession` already sends `DBG_EXIT`; this pins down *why* it has to:
 * exiting debug mode is what releases the probe and clears the hardware
 * breakpoints, and skipping it (kill the process instead) leaves the ST-Link
 * unavailable — measured on this bench, three probe runs in a row ended with
 * `ST-LINK error (DEV_USB_COMM_ERR)` from STM32CubeProgrammer and
 * `Flash Download failed - Target DLL has been cancelled` from uVision, and
 * only a physical replug recovered it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("closing a debugging session leaves the debugger before the process goes", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync("src/embedded/keilSession.ts", "utf8"));
  const body = source.slice(source.indexOf("export async function closeKeilSession"), source.indexOf("export async function closeAllKeilSessions"));
  const debugExit = body.indexOf("DBG_EXIT");
  const processExit = body.indexOf("client.exit()");
  assert.ok(debugExit >= 0, "DBG_EXIT is sent");
  assert.ok(processExit >= 0, "the process is asked to exit");
  assert.ok(debugExit < processExit, "the debugger is left before uVision is closed — that is what releases the probe");
});
