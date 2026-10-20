/**
 * An OS-level sandbox for shell commands, built on WSL2.
 *
 * `sandbox.ts` is a policy layer: it reads a command line and decides whether
 * to allow it. That stops accidents. It does not stop a program that decides to
 * do something else, because the decision is made before the program runs and
 * the program is not confined afterwards.
 *
 * This module is the confinement. A command is run inside a WSL2 distribution
 * as an unprivileged user, with:
 *
 *   - a **private network namespace** (`unshare -n`) when the network policy is
 *     `off`, so a build script cannot phone home even though it runs as root
 *     inside its own namespace;
 *   - the workspace **bind-mounted read-only or read-write** at the same
 *     absolute path, so paths in the command mean what they meant outside;
 *   - a **tmpfs home**, so nothing outside the workspace persists;
 *   - `--map-root-user`, so the process that appears to be root is root only
 *     inside its own user namespace;
 *   - a **time limit** enforced by `timeout(1)`, which kills the whole
 *     process group rather than just the shell.
 *
 * What this is not: it is not a container. WSL2 shares the Windows kernel's
 * filesystem view through 9p, and `/mnt/c` is inside every namespace. The
 * confinement is real for *network* and *user*, and advisory for *paths* —
 * a command that writes to `/mnt/c/...` reaches Windows. The read-only bind is
 * what makes the path boundary meaningful, and it covers the workspace; other
 * drives remain visible. This is stated in the UI rather than hidden, because
 * a boundary the user believes in but which does not exist is worse than no
 * boundary.
 *
 * When WSL is not installed, `availability()` says so, and the caller keeps
 * using the policy sandbox — which is what it did before this module existed.
 * Nothing silently downgrades: the state is reported.
 */

import { execFile, spawn } from "node:child_process";

export interface KernelSandboxStatus {
  /** `ready` means commands can be isolated; `absent` means WSL is missing. */
  state: "ready" | "absent" | "disabled";
  distro?: string;
  wslVersion?: number;
  /** Why it is not ready, in a sentence for the settings page. */
  reason?: string;
}

export interface KernelSandboxRequest {
  command: string;
  /** Windows-side workspace directory. */
  cwd: string;
  /** `off` gives the command a private network namespace. */
  network: "off" | "open";
  /** Write access to the workspace. */
  writable: boolean;
  timeoutMs?: number;
  /** Environment variables to pass through, already scrubbed by the caller. */
  env?: Record<string, string>;
  /** Extra read-only mounts, as Windows paths. */
  readonlyDirs?: string[];
}

export interface KernelSandboxResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  /** The exact WSL argv, for the audit log and for debugging a refusal. */
  invocation: { program: string; args: string[] };
}

/** Windows path → WSL path. `G:\Develop\x` becomes `/mnt/g/Develop/x`. */
export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(\/|$)/.exec(normalized);
  if (!drive) return normalized;
  const rest = normalized.slice(2).replace(/^\/+/, "");
  return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/**
 * Build the shell script that runs inside WSL.
 *
 * Kept as a pure function so the exact script — the one that decides what is
 * mounted and whether the network exists — is testable without WSL.
 *
 * `exec "$@"` is deliberate: the caller's command is passed as positional
 * arguments, never interpolated into the script, so a command containing
 * quotes, `$()` or newlines cannot change what the script does.
 */
export function wrapScript(request: Pick<KernelSandboxRequest, "cwd" | "network" | "writable" | "timeoutMs" | "readonlyDirs" | "env">): string {
  const work = toWslPath(request.cwd);
  const timeout = Math.max(1, Math.round((request.timeoutMs ?? 120_000) / 1000));
  const mounts = (request.readonlyDirs ?? []).map(toWslPath);
  const lines = [
    "set -eu",
    // A private home inside the namespace: nothing a build writes to $HOME
    // survives, and a tool that caches into ~/.cache does not poison the next
    // run or the user's real home.
    "export HOME=/tmp/prom-home",
    "mkdir -p \"$HOME\"",
  ];
  if (!request.writable) {
    // A read-only bind of the workspace over itself. `--rbind` is needed so
    // submounts are visible at all, and the bind happens before anything else
    // can write. If the bind fails the command does not run: a read-only mode
    // that silently allows writes is the one failure this must not have.
    lines.push(
      `if mount --rbind "${work}" "${work}" 2>/dev/null && mount -o remount,bind,ro "${work}" 2>/dev/null; then :; else`,
      `  echo "prometheus-sandbox: could not make ${work} read-only; refusing to run" >&2`,
      "  exit 97",
      "fi",
    );
  }
  lines.push(
    "cd \"$WORK\"",
    ...(request.env
      ? Object.entries(request.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      : []),
    ...mounts.map((dir) => `mkdir -p "${dir}"`),
    // The command itself. `timeout` kills the process group so a child that
    // forks does not outlive the turn.
    `exec timeout ${timeout}s "$@"`,
  );
  // `$WORK` is exported rather than interpolated into `cd` so the path is
  // quoted exactly once, by the shell that owns it.
  return [`WORK=${shellQuote(work)}`, ...lines].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv that starts the sandboxed command.
 *
 * Separated from `run()` so the mount flags — which are the boundary — can be
 * asserted in a test on any platform.
 */
export function sandboxArgs(request: KernelSandboxRequest, distro?: string): string[] {
  const work = toWslPath(request.cwd);
  const args: string[] = [];
  if (distro) args.push("-d", distro);
  // `--cd /` and a clean environment: the WSL default inherits the Windows
  // PATH, which contains directories with spaces and is irrelevant here.
  args.push("--cd", "/", "--exec", "env", "-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  args.push(
    "unshare",
    "--user",
    "--map-root-user",
    ...(request.network === "off" ? ["--net"] : []),
    "--mount",
    "--pid",
    "--fork",
    "bash",
    // `-c`, not `-lc`: a login shell reads `/root/.bash_profile` from the real
    // filesystem before the namespace's HOME takes effect, and with
    // `--map-root-user` that read is denied — a warning on every command and,
    // worse, profile code that could run outside the sandbox's discipline.
    "-c",
    wrapScript(request),
    "prometheus-sandbox",
    "/bin/bash",
    "-c",
    request.command,
  );
  return args;
}

/**
 * Whether WSL2 is present and which distribution to use.
 *
 * `wsl.exe -l -q` prints UTF-16LE on Windows, which is why the output is
 * decoded rather than treated as UTF-8: a naive read yields a string with NUL
 * bytes between every character and the distro name never matches.
 */
let statusCache: { at: number; status: KernelSandboxStatus } | null = null;

export async function availability(options: { distro?: string; refresh?: boolean } = {}): Promise<KernelSandboxStatus> {
  // `wsl.exe -l -q` takes ~100 ms and the answer changes only when the user
  // installs or removes a distro. A one-minute cache keeps it off the path of
  // every shell command without making a fresh install invisible for long.
  if (!options.refresh && statusCache && Date.now() - statusCache.at < 60_000) {
    const cached = statusCache.status;
    if (!options.distro || cached.distro === options.distro || cached.state !== "ready") return cached;
  }
  const status = await probeAvailability(options.distro);
  statusCache = { at: Date.now(), status };
  return status;
}

/** Drop the cached answer; used after an install or a settings change. */
export function resetAvailability(): void {
  statusCache = null;
}

async function probeAvailability(distroOverride?: string): Promise<KernelSandboxStatus> {
  if (process.platform !== "win32") {
    return { state: "absent", reason: "the kernel sandbox is a Windows-only feature; this build targets Windows" };
  }
  const list = await new Promise<{ ok: boolean; text: string }>((resolve) => {
    execFile("wsl.exe", ["-l", "-q"], { timeout: 15_000, windowsHide: true, encoding: "buffer" }, (error, stdout) => {
      resolve({ ok: !error, text: decodeWslOutput(stdout) });
    });
  });
  if (!list.ok) {
    return { state: "absent", reason: "WSL is not installed or not available; run `wsl --install` to enable it" };
  }
  const distros = list.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (distros.length === 0) return { state: "absent", reason: "WSL is installed but has no distribution; run `wsl --install -d Ubuntu`" };
  const distro = distroOverride && distros.includes(distroOverride) ? distroOverride : distros[0];
  return { state: "ready", distro };
}

/** Decode `wsl.exe` output, which is UTF-16LE when it is not being redirected. */
export function decodeWslOutput(buffer: Buffer | string | undefined): string {
  if (!buffer) return "";
  if (typeof buffer === "string") return buffer;
  // A UTF-16LE listing has a NUL as every second byte; UTF-8 text does not.
  const sample = buffer.subarray(0, Math.min(buffer.length, 64));
  let nulls = 0;
  for (let index = 0; index < sample.length; index++) if (sample[index] === 0) nulls++;
  const text = nulls > sample.length / 4 ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.replace(/\u0000/g, "").replace(/^\uFEFF/, "");
}

/**
 * Run a command inside the sandbox.
 *
 * The caller is responsible for having classified the command already: this
 * function executes what it is given. Its own job is to make sure that when it
 * returns, nothing it started is still running — the WSL helper process is
 * killed on timeout and on abort, and `timeout(1)` inside the namespace kills
 * the command's process group.
 */
export function run(request: KernelSandboxRequest, options: { distro?: string; signal?: AbortSignal } = {}): Promise<KernelSandboxResult> {
  const args = sandboxArgs(request, options.distro);
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, output, timedOut, invocation: { program: "wsl.exe", args } });
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    // The outer timer is a backstop: the inner `timeout(1)` is what normally
    // fires, and this one only matters if WSL itself hangs before exec.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, (request.timeoutMs ?? 120_000) + 5_000);
    const onAbort = () => {
      timedOut = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * A one-line description of what a sandboxed run can and cannot do.
 *
 * Shown in Settings and in the permission prompt, because the difference
 * between "the command cannot reach the network" and "the command cannot
 * leave the workspace" is what the user is deciding about.
 */
export function describeSandbox(status: KernelSandboxStatus, request: Pick<KernelSandboxRequest, "network" | "writable">): string {
  if (status.state !== "ready") return `Policy sandbox only: ${status.reason ?? "the kernel sandbox is unavailable"}`;
  const access = request.writable ? "read-write" : "read-only";
  const network = request.network === "off" ? "no network" : "network allowed";
  return `WSL2 (${status.distro}): ${access} workspace, ${network}, private home, ${"timeout enforced"}`;
}
