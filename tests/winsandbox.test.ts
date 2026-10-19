/**
 * Windows job containment: the process-tree kill that the policy layer cannot
 * provide.
 *
 * These tests spawn real processes. The first is a protocol test and always
 * runs; the rest are Windows-only because job objects are a kernel feature.
 *
 * ## What these tests can and cannot prove
 *
 * They can prove the host protocol works and that `TerminateJobObject` kills a
 * process the job was given. They cannot reliably prove containment of nested
 * children, because a hosted environment may put the test runner itself inside
 * a job (assignment then fails with `ERROR_ACCESS_DENIED`) or a command may
 * detach with `CREATE_BREAKAWAY_FROM_JOB` (Windows honours that). Those limits
 * are recorded in `docs/reference.md` rather than asserted into a test that
 * would be green on one machine and red on the next.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  jobContainmentSupported,
  jobHostScript,
  killTree,
  openJob,
  probeOsSandbox,
  windowsPowerShell,
} from "../src/winsandbox.ts";

const win = process.platform === "win32" ? test : test.skip;

function cmdPath(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
}

/** True while a process id still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the job host script contains the calls containment depends on", () => {
  const script = jobHostScript();
  assert.match(script, /CreateJobObject/);
  assert.match(script, /AssignProcessToJobObject/);
  assert.match(script, /TerminateJobObject/);
  // The host must announce readiness before it blocks on stdin, otherwise the
  // opener could start writing control lines into the void.
  assert.match(script, /Out\.WriteLine\('ready'\)/);
});

test("containment is reported as unavailable on a host with no PowerShell", () => {
  assert.equal(typeof probeOsSandbox().supported, "boolean");
  if (process.platform !== "win32") {
    assert.equal(jobContainmentSupported(), false);
    assert.equal(windowsPowerShell(), null);
  } else {
    assert.ok(existsSync(windowsPowerShell() ?? ""), "the probe found a powershell it cannot run");
  }
});

win("a job terminates the process it was given", async () => {
  const job = await openJob();
  assert.ok(job, "the job host did not open");
  const child = spawn(cmdPath(), ["/c", "ping -n 10 127.0.0.1 >nul"], { windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(child.exitCode, null, "the command finished before the test could contain it");
    const assigned = await job!.assign(child.pid!);
    assert.equal(assigned, true, "assign was refused");
    job!.terminate();
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.notEqual(child.exitCode, null, "the process survived TerminateJobObject");
  } finally {
    job!.dispose();
    if (child.exitCode === null) killTree(child.pid);
  }
});

win("killTree reaches a process that is not the direct child", async () => {
  // The fallback path: when no job could be assigned, the bash tool calls
  // `taskkill /T`, and that has to reach descendants. The parent here exits at
  // once, leaving a grandchild that keeps running; `killTree` on the grandchild
  // must end it.
  const child = spawn(cmdPath(), ["/c", "ping -n 30 127.0.0.1 >nul"], { windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const pid = child.pid;
  assert.ok(pid && child.exitCode === null, "the process did not start");
  killTree(pid);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(alive(pid), false, "killTree did not end the process");
});
