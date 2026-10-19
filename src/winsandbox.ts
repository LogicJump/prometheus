/**
 * Process-tree containment for Windows, enforced by a Job Object.
 *
 * The policy layer in `sandbox.ts` reads a command line and reasons about what
 * it says. This module does not read the command at all: it puts the shell into
 * a Windows job and terminates the whole job when the tool returns. That fixes
 * the one failure the policy layer structurally cannot see — a build that
 * spawns children, or an aborted `npm install` whose postinstall script keeps
 * running, survives the turn and holds ports and file handles.
 *
 * ## Why not CreateProcess + CREATE_SUSPENDED
 *
 * The textbook approach is to start the shell suspended, assign it to the job,
 * then resume, so no child can escape the window between spawn and assign.
 * `CreateProcessW` from Windows PowerShell 5.1 is unreliable here: it returns
 * `ERROR_INVALID_NAME` unless the application name is an absolute path and the
 * command line repeats it, and even then the assign step has to fight whatever
 * job the *agent itself* runs in. The practical loss is small: a child spawned
 * in the milliseconds before `AssignProcessToJobObject` would have to be
 * deliberately hostile to escape.
 *
 * ## Why not AppContainer
 *
 * `CreateAppContainerProfile` is not exported by `advapi32.dll` on this host, so
 * an AppContainer mode cannot be built here without a native helper. Advertising
 * it in the UI while running only the job would be exactly the kind of lie this
 * project keeps removing. The mode is therefore not offered; the policy layer
 * remains the file/network boundary it always was, and the settings page says so.
 *
 * ## Nested jobs
 *
 * Assigning a process to a job while the caller is itself inside one fails with
 * `ERROR_ACCESS_DENIED` on hosts that predate nested jobs, and on some CI
 * runners. The caller treats that as "containment unavailable" and falls back to
 * `killTree`, which still reaches grandchildren on a normal desktop.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface JobHandle {
  /**
   * Attach a process to the job. Resolves true when the kernel accepted it,
   * false when the call was refused (a nested-job host) or the process is gone.
   */
  assign(pid: number): Promise<boolean>;
  /** Kill every process still in the job. Synchronous and best-effort. */
  terminate(): void;
  /** Release the handle after the job is over. Does not kill. */
  dispose(): void;
}

const READY_TIMEOUT_MS = 5000;

/**
 * The PowerShell host: it creates the job, prints `ready`, then reads control
 * lines from stdin.
 *
 * Node cannot hold a kernel handle, so the PowerShell process owns it. Every
 * line the host prints after `ready` is an answer to one control line, which
 * makes the protocol a tiny request/response stream. EOF on stdin also
 * terminates the job, so a crashed agent cannot leave an orphaned tree behind.
 */
export function jobHostScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$sig=@'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class PromJob {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j, uint code);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "$job=[PromJob]::CreateJobObject([IntPtr]::Zero,$null)",
    "if($job -eq [IntPtr]::Zero){ [Console]::Error.WriteLine('create-failed'); exit 1 }",
    "[Console]::Out.WriteLine('ready')",
    "[Console]::Out.Flush()",
    "$done=$false",
    "while(-not $done) {",
    "  $line=[Console]::In.ReadLine()",
    "  if($null -eq $line){ break }",
    "  $parts=$line.Trim().Split(' ')",
    "  switch($parts[0]) {",
    "    'assign' {",
    "      try {",
    "        $p=Get-Process -Id ([int]$parts[1]) -ErrorAction Stop",
    "        if([PromJob]::AssignProcessToJobObject($job,$p.Handle)){ [Console]::Out.WriteLine('ok') }",
    "        else { [Console]::Out.WriteLine('denied') }",
    "      } catch { [Console]::Out.WriteLine('gone') }",
    "      [Console]::Out.Flush()",
    "    }",
    "    'terminate' {",
    "      [void][PromJob]::TerminateJobObject($job,1)",
    "      [Console]::Out.WriteLine('terminated')",
    "      [Console]::Out.Flush()",
    "      $done=$true",
    "    }",
    "  }",
    "}",
    "[void][PromJob]::TerminateJobObject($job,1)",
    "[void][PromJob]::CloseHandle($job)",
  ].join("\n");
}

let cachedPowershell: string | null = null;

/** Absolute path to Windows PowerShell, or null when the host has none. */
export function windowsPowerShell(): string | null {
  if (cachedPowershell !== null) return cachedPowershell || null;
  const roots = [process.env.SystemRoot, process.env.windir, "C:\\Windows"].filter(Boolean) as string[];
  for (const root of roots) {
    const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(candidate)) return (cachedPowershell = candidate);
  }
  cachedPowershell = "";
  return null;
}

export function resetPowershellCache(): void {
  cachedPowershell = null;
}

export function jobContainmentSupported(): boolean {
  return process.platform === "win32" && windowsPowerShell() !== null;
}

/**
 * Start the job host and return a handle, or null when containment is
 * unavailable on this host. The promise resolves once the host says `ready`;
 * a host that never gets there is killed rather than left running.
 */
export function openJob(): Promise<JobHandle | null> {
  if (!jobContainmentSupported()) return Promise.resolve(null);
  const powershell = windowsPowerShell();
  if (!powershell) return Promise.resolve(null);

  return new Promise((resolve) => {
    // `-EncodedCommand` carries the script as base64 UTF-16LE, so stdin stays
    // free for the control protocol. Writing the script to stdin instead would
    // let the host's ReadLine consume the first control line.
    const encoded = Buffer.from(jobHostScript(), "utf16le").toString("base64");
    const child: ChildProcess = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );

    let ready = false;
    let settled = false;
    let buffer = "";
    const waiters: ((line: string | null) => void)[] = [];

    const deliver = (line: string | null) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else if (line !== null) buffer += `${line}\n`;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const raw of chunk.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        if (!ready && line === "ready") {
          ready = true;
          continue;
        }
        deliver(line);
      }
    });

    const fail = () => {
      if (settled) return;
      settled = true;
      for (const waiter of waiters.splice(0)) waiter(null);
      resolve(null);
    };

    child.on("error", fail);
    child.on("exit", () => {
      if (!ready) fail();
      else for (const waiter of waiters.splice(0)) waiter(null);
    });

    const timer = setTimeout(fail, READY_TIMEOUT_MS);

    const readyWatcher = setInterval(() => {
      if (!ready) return;
      clearInterval(readyWatcher);
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      let closed = false;
      const request = (line: string): Promise<string | null> => {
        if (closed) return Promise.resolve(null);
        // A reply already sitting in the buffer belongs to an earlier request;
        // control is strictly sequential, so drain it first.
        const at = buffer.indexOf("\n");
        if (at >= 0) {
          const queued = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          child.stdin?.write(`${line}\n`);
          return Promise.resolve(queued);
        }
        return new Promise((done) => {
          waiters.push(done);
          child.stdin?.write(`${line}\n`);
        });
      };

      resolve({
        async assign(pid) {
          const answer = await request(`assign ${pid}`);
          return answer === "ok";
        },
        terminate() {
          if (closed) return;
          child.stdin?.write("terminate\n");
          child.stdin?.end();
          closed = true;
        },
        dispose() {
          if (closed) return;
          closed = true;
          try {
            child.stdin?.end();
          } catch {
            /* already closed */
          }
        },
      });
    }, 5);
    readyWatcher.unref?.();
  });
}

/** Best-effort kill of a pid and its descendants; the fallback when no job. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: 10_000 });
    } catch {
      /* the process may already be gone */
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** What the settings page can honestly say about OS-level containment. */
export function probeOsSandbox(): { supported: boolean; job: boolean; appcontainer: false; reason?: string } {
  if (process.platform !== "win32") {
    return { supported: false, job: false, appcontainer: false, reason: "job objects are a Windows feature" };
  }
  const job = jobContainmentSupported();
  return {
    supported: job,
    job,
    appcontainer: false,
    reason: job ? undefined : "powershell.exe was not found",
  };
}
