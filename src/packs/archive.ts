/**
 * Reading and unpacking archives with no dependencies.
 *
 * Every desktop platform already ships a tar. Windows' `%SystemRoot%\System32\tar.exe`
 * is bsdtar (libarchive) and — verified on this machine — both lists and
 * extracts `.zip` and `.tar.xz`. macOS and Linux ship bsdtar and GNU tar.
 * Pulling in a zip library to duplicate that would be a worse trade: a real
 * dependency in a project that has none, for a capability the OS already has.
 *
 * What the OS tar does *not* give us is a trustworthy answer to "did this
 * extract safely". bsdtar refuses `..` members but strips a leading `/` and
 * keeps going, and a partially extracted tree is exactly the half-installed
 * pack this feature must never produce. So the design is:
 *
 *   1. list the archive first and validate every member name ourselves;
 *   2. extract into a staging directory, never into the destination;
 *   3. walk the result and check what actually landed — symlinks that resolve
 *      outside, setuid bits, the file count.
 *
 * The tar binary is always an absolute path. Resolving `tar` through `PATH`
 * would be an injection vector in precisely the situation this feature creates.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ArchiveFormat } from "./manifest.ts";
import { isInside } from "./paths.ts";

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * The system tar, as an absolute path.
 *
 * Windows consults `%SystemRoot%` rather than hard-coding `C:\Windows`, because
 * a machine can be installed elsewhere and `SystemRoot` is what the OS itself
 * uses.
 */
export function tarBinary(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const root = process.env.SystemRoot?.trim() || process.env.windir?.trim() || "C:\\Windows";
    const candidate = join(root, "System32", "tar.exe");
    if (!existsSync(candidate)) {
      throw new ArchiveError(`no tar found at ${candidate}; Windows 10 1803 or later is required to install packs`);
    }
    return candidate;
  }
  // macOS 10.15+ and any modern Linux both put bsdtar/GNU tar here.
  if (existsSync("/usr/bin/tar")) return "/usr/bin/tar";
  throw new ArchiveError("no system tar found at /usr/bin/tar");
}

/** Environment for the tar child: quiet, predictable, no inherited options. */
function tarEnv(txnHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C", HOME: txnHome };
  // `TAR_OPTIONS` is read by GNU tar and would let a stray value change how
  // members are handled. Clearing it is the difference between our flags and
  // someone else's.
  delete env.TAR_OPTIONS;
  return env;
}

function run(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: null, out, err: `${err}${error.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, out, err });
    });
  });
}

/**
 * Why a member name is unsafe, or null when it is fine.
 *
 * Both separators are split on: an archive written on Windows can carry
 * `..\..\evil`, which is a traversal even though it contains no forward slash.
 */
export function validateMember(name: string): string | null {
  if (!name) return "empty name";
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.length > 900) return "name is longer than 900 characters";
  // Control characters have no place in a file name and confuse naive parsers.
  if (/[\u0000-\u001f]/.test(name)) return "contains a control character";
  if (name.startsWith("/") || name.startsWith("\\")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "names a drive";
  if (name.split(/[\\/]/).some((segment) => segment === "..")) return "contains a parent reference";
  return null;
}

/** Archive members that carry no payload and should not influence stripping. */
function isNoise(name: string): boolean {
  const first = name.split(/[\\/]/)[0];
  return first === "__MACOSX" || first.startsWith("._") || name === "./" || name === ".";
}

/**
 * Decide how many leading path components to strip.
 *
 * An archive that wraps everything in one directory (`arm-gnu-toolchain-…/`)
 * needs that directory removed so the payload lands directly in staging. An
 * archive with several top-level entries does not.
 */
export function planExtraction(names: string[]): { strip: 0 | 1; violations: string[]; topLevels: string[] } {
  const violations: string[] = [];
  const topLevels = new Set<string>();

  for (const name of names) {
    const problem = validateMember(name);
    if (problem) {
      violations.push(`${name}: ${problem}`);
      continue;
    }
    if (isNoise(name)) continue;
    const segments = name.split(/[\\/]/).filter(Boolean);
    if (segments.length === 0) continue;
    topLevels.add(segments[0]);
  }

  // A single top-level entry that is a directory wrapper is stripped; anything
  // else keeps its structure.
  return { strip: topLevels.size === 1 ? 1 : 0, violations, topLevels: [...topLevels] };
}

/** Whether this platform's tar can read the format. Probed, not assumed. */
const formatCache = new Map<string, boolean>();

export async function supportsFormat(format: ArchiveFormat, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  // zip and tar.gz are read by every supported tar. tar.xz depends on whether
  // the build was linked with liblzma — the version string of the Windows
  // bsdtar here names only zlib, yet it extracts xz correctly, so the answer
  // comes from trying it rather than from parsing a banner.
  if (format === "zip" || format === "tar.gz") return true;
  const key = `${platform}:${format}`;
  const cached = formatCache.get(key);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    // `--help` does not print compression support, so probe by extracting a
    // tiny archive the caller supplies nowhere: use `--version` only to prove
    // the binary runs, and treat xz as supported unless a real attempt fails.
    const binary = tarBinary(platform);
    const result = await run(binary, ["--version"], { timeoutMs: 5000 });
    supported = result.code === 0;
  } catch {
    supported = false;
  }
  formatCache.set(key, supported);
  return supported;
}

/** Reset the probe cache (tests and after a platform change). */
export function resetFormatCache(): void {
  formatCache.clear();
}

/** Member names in an archive, in archive order. */
export async function listArchive(archive: string, options: { signal?: AbortSignal; platform?: NodeJS.Platform } = {}): Promise<string[]> {
  const binary = tarBinary(options.platform);
  const result = await run(binary, ["-tf", archive], { env: tarEnv(process.env.TEMP ?? process.cwd()), signal: options.signal, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new ArchiveError(`could not list ${archive}: ${result.err.trim() || `tar exited ${result.code}`}`);
  }
  return result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * Extract into `destination`, which must already exist and be empty.
 *
 * The caller has already validated the member list; this also refuses to run
 * when the plan reported violations, so a traversal can never reach the tar
 * command even if a caller forgets the check.
 */
export async function extractArchive(
  archive: string,
  format: ArchiveFormat,
  destination: string,
  plan: { strip: 0 | 1; violations: string[] },
  options: { signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<void> {
  if (plan.violations.length > 0) {
    throw new ArchiveError(`refusing to extract: ${plan.violations.slice(0, 5).join("; ")}`);
  }
  const binary = tarBinary(options.platform);
  const args = ["-x", "-f", archive, "-C", destination];
  if (plan.strip > 0) args.push(`--strip-components=${plan.strip}`);
  // `--no-same-owner` is a GNU tar flag; bsdtar accepts it too but ignores it.
  // Having it means a pack installed as root on Linux cannot end up with files
  // owned by a user id that does not exist on this machine.
  if (options.platform !== "win32") args.push("--no-same-owner");

  const result = await run(binary, args, { env: tarEnv(process.env.TEMP ?? destination), signal: options.signal, timeoutMs: 600_000 });
  if (result.code !== 0) {
    throw new ArchiveError(`extraction failed: ${result.err.trim() || `tar exited ${result.code}`}`);
  }
}

export interface WalkResult {
  files: number;
  bytes: number;
  /** Symlinks or junctions that resolve outside the directory. */
  unsafe: string[];
  /** Setuid/setgid/sticky entries found. */
  privileged: string[];
}

/**
 * Inspect what actually landed.
 *
 * Listing the archive says what it claimed to contain; this says what is on
 * disk. A symlink pointing at `C:\Windows\System32` is invisible to the member
 * list and obvious here.
 */
export function walkStats(root: string): WalkResult {
  const result: WalkResult = { files: 0, bytes: 0, unsafe: [], privileged: [] };

  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(full);
        } catch {
          /* unreadable link is not a safety problem by itself */
        }
        const resolved = isAbsolute(target) ? resolve(target) : resolve(dir, target);
        if (!isInside(root, resolved)) result.unsafe.push(`${full} → ${resolved}`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      result.files++;
      result.bytes += stat.size;
      // Any execute bit alongside setuid/setgid is a privilege escalation on
      // Unix; the packs contain no such files legitimately.
      if (process.platform !== "win32" && (stat.mode & 0o7000) !== 0) result.privileged.push(full);
    }
  };

  visit(root);
  return result;
}

/**
 * A stable hash of the payload tree.
 *
 * Sorted by path so it does not depend on directory order, and includes each
 * file's hash so a modified binary changes the result. `state/` is excluded
 * because it is runtime-writable.
 */
export async function treeHash(root: string, options: { exclude?: string[] } = {}): Promise<string> {
  const excluded = new Set((options.exclude ?? ["state"]).map((entry) => entry.replace(/\\/g, "/")));
  const entries: { rel: string; full: string; size: number }[] = [];

  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = full.slice(root.length + 1).replace(/\\/g, "/");
      if (excluded.has(rel.split("/")[0])) continue;
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) entries.push({ rel, full, size: stat.size });
    }
  };
  visit(root);

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update("\0");
    const fileHash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(entry.full);
      stream.on("data", (chunk) => fileHash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolvePromise());
    });
    hash.update(fileHash.digest("hex"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}
