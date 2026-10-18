/**
 * Installing a pack, transactionally.
 *
 * The rule this module exists to enforce: **`packs/` never contains a pack that
 * is not complete and validated.** Everything else is machinery to make that
 * true under interruption, disk exhaustion, corruption and cancellation.
 *
 *   preflight ─ disk check, id check, nothing written
 *   download ── into tmp/txn-<random>, hashed as it streams
 *   verify ──── SHA-256; a mismatch deletes the archive and stops
 *   list ────── members validated before a single file is written
 *   extract ─── into tmp/txn-<random>/staging
 *   inspect ─── what actually landed: symlinks, setuid, counts
 *   validate ── run the toolchain and match its answer
 *   commit ──── one atomic rename into packs/<id>
 *
 * A failure at any step leaves the transaction directory and nothing else.
 * A power loss before the rename leaves the same. A power loss during the
 * rename is safe because rename is atomic: either the old directory or the new
 * one exists, never a mixture.
 *
 * Every external effect is injected, so the whole failure matrix is testable
 * without a network or a real 300 MB download.
 */

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { downloadVerified, importArchive } from "./download.ts";
import { extractArchive, listArchive, planExtraction, tarBinary, treeHash, walkStats } from "./archive.ts";
import { parseManifest, writeManifest, type PackManifest } from "./manifest.ts";
import { acquireRootLock, assertPackId, ensureRoot, isOwnedRoot, packDir, packsRoot, tmpDir } from "./paths.ts";

export type PackPhase = "preflight" | "download" | "verify" | "extract" | "inspect" | "validate" | "commit";

export interface PackProgress {
  id: string;
  phase: PackPhase;
  received?: number;
  total?: number;
  message?: string;
}

export interface CatalogEntry {
  manifest: PackManifest;
  /** Extra disk the archive expands to, used for the space check. */
  unpackedBytes?: number;
  /** Human-readable size, shown in the UI before download. */
  downloadBytes?: number;
}

export interface InstallDeps {
  download?: typeof downloadVerified;
  importArchive?: typeof importArchive;
  list?: typeof listArchive;
  extract?: typeof extractArchive;
  walk?: typeof walkStats;
  hashTree?: typeof treeHash;
  runValidation?: typeof runValidation;
}

export interface InstallOptions {
  root?: string;
  signal?: AbortSignal;
  replace?: boolean;
  /** Skip the catalog hash check; only for "install from file". */
  allowUnverified?: boolean;
  /**
   * Local archives to use instead of downloading, one per entry in
   * `manifest.sources`. Used by "install from file"; the bytes are still
   * checked against the manifest's checksums.
   */
  localFiles?: string[];
  onProgress?: (progress: PackProgress) => void;
  deps?: InstallDeps;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** Free bytes on the volume holding `path`, or null when it cannot be read. */
export function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path, { bigint: true });
    // `bavail` is reserved for unprivileged users and is 0 on some Windows
    // builds; `bfree` is the fallback there.
    const blocks = stats.bavail > 0n ? stats.bavail : stats.bfree;
    return Number(blocks * stats.bsize);
  } catch {
    return null;
  }
}

/** Run the pack's own validation command and match its answer. */
export async function runValidation(
  payloadRoot: string,
  manifest: PackManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string; reason?: string }> {
  const command = join(payloadRoot, manifest.validation.command);
  if (!existsSync(command)) {
    return { ok: false, output: "", reason: `${manifest.validation.command} was not produced by the archive` };
  }

  const env = { ...process.env };
  // The binary may need its siblings on PATH (arm-none-eabi-gcc locates `as`
  // and `ld` next to itself); giving it only its own directory keeps that
  // working without exposing the host's toolchains.
  //
  // `pathPrepend` is relative to the pack root (`payload/bin`), while
  // `payloadRoot` is already the payload, so the payload prefix is stripped
  // back off before joining.
  const firstBin = manifest.env.pathPrepend[0] ?? manifest.payload.root;
  const binRelative = firstBin.startsWith(manifest.payload.root + "/")
    ? firstBin.slice(manifest.payload.root.length + 1)
    : firstBin;
  env.PATH = join(payloadRoot, binRelative) + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "");

  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolvePromise) => {
    const child = spawn(command, manifest.validation.args, {
      cwd: payloadRoot,
      env,
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
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, out, err });
    };
    child.on("error", (error) => {
      err += error.message;
      finish(null);
    });
    child.on("close", finish);
  });

  const text = `${result.out}${result.err}`.trim();
  if (!new RegExp(manifest.validation.expect, "m").test(text)) {
    return {
      ok: false,
      output: text,
      reason: `validation failed: expected output matching /${manifest.validation.expect}/, got ${JSON.stringify(text.slice(0, 200))}`,
    };
  }

  // The same completeness check the detector uses: a compiler that answers
  // `-dumpmachine` but has no C library is the Homebrew trap, and installing it
  // would be worse than refusing.
  if (manifest.provides.includes("gcc-arm")) {
    const libc = await probeLibc(command, options);
    if (libc !== null && !/[\\/]/.test(libc)) {
      return { ok: false, output: text, reason: `this toolchain has no C library (${libc}); it cannot link` };
    }
  }

  return { ok: true, output: text };
}

function probeLibc(gcc: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(gcc, ["-print-file-name=libc.a"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener("abort", () => child.kill(), { once: true });
    const finish = () => {
      clearTimeout(timer);
      resolvePromise(out.trim() || null);
    };
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.on("close", finish);
  });
}

/**
 * Install a pack.
 *
 * `entry.manifest` is the manifest that will be written; its `installedAt` is
 * stamped here rather than trusted from the catalog.
 */
export async function installPack(entry: CatalogEntry, options: InstallOptions = {}): Promise<PackManifest> {
  const root = options.root ?? packsRoot();
  const id = entry.manifest.id;
  const phase = (name: PackPhase, extra: Omit<PackProgress, "id" | "phase"> = {}) =>
    options.onProgress?.({ id, phase: name, ...extra });

  const deps: Required<InstallDeps> = {
    download: options.deps?.download ?? downloadVerified,
    importArchive: options.deps?.importArchive ?? importArchive,
    list: options.deps?.list ?? listArchive,
    extract: options.deps?.extract ?? extractArchive,
    walk: options.deps?.walk ?? walkStats,
    hashTree: options.deps?.hashTree ?? treeHash,
    runValidation: options.deps?.runValidation ?? runValidation,
  };

  // ---- preflight: refuse before writing anything ---------------------------
  phase("preflight");
  assertPackId(id);

  const manifest = parseManifest(entry.manifest, `catalog:${id}`);
  if (!options.allowUnverified && manifest.sources.some((source) => !source.sha256)) {
    throw new InstallError(`${id} has no checksum; refusing to install an unverified pack`);
  }

  const destination = packDir(root, id);
  if (existsSync(destination) && !options.replace) {
    throw new InstallError(`${id} is already installed at ${destination}. Remove it first, or install with replace.`);
  }

  const archiveBytes = manifest.sources.reduce((sum, source) => sum + source.bytes, 0);
  const installedBytes = entry.unpackedBytes ?? archiveBytes * 4;
  // 15% headroom: the staging tree and the final tree briefly coexist for the
  // same pack during a replace, and filesystems report less free space than
  // they have.
  const needed = Math.ceil(archiveBytes + installedBytes * 1.15);
  const free = freeBytes(existsSync(root) ? root : process.cwd());
  if (free !== null && free < needed) {
    throw new InstallError(
      `not enough disk space in ${root}: need about ${formatBytes(needed)}, ${formatBytes(free)} free. ` +
        `Nothing was downloaded. Free some space, or point ${"PROMETHEUS_TOOLCHAIN_HOME"} at another volume.`,
    );
  }

  ensureRoot(root);
  if (!isOwnedRoot(root)) {
    throw new InstallError(`${root} exists but is not a Prometheus toolchain directory; refusing to write into it`);
  }

  // The lock covers everything from the first byte downloaded to the commit.
  // It is deliberately taken after the checks that write nothing, so a refusal
  // for a bad id or a full disk never has to wait for another window.
  const lock = acquireRootLock(root, { id });

  // ---- transaction --------------------------------------------------------
  // Created inside the `try` so a failure here still reaches `finally` and
  // releases the lock. `txn` stays null until the directory exists.
  let txn: string | null = null;

  try {
    txn = mkdtempSync(join(tmpDir(root), "txn-"));
    // The pack directory is `pack.json` + `NOTICE.md` + `payload/`. Extraction
    // lands inside `payload` so the committed tree already has its final shape —
    // a pack directory whose layout only becomes correct after a move is a pack
    // that can be observed in the wrong state.
    const payloadStage = join(txn, manifest.payload.root);
    // tar 的 `-C` 要求目标目录已经存在；不建的话它会 chdir 失败，而错误信息
    // 出现在下载和校验都成功之后 —— 那是最让人困惑的失败位置。
    mkdirSync(payloadStage, { recursive: true });
    // Download every source; a composite pack (Zephyr) has more than one.
    const archives: { path: string; format: PackManifest["sources"][number]["archive"] }[] = [];
    if (options.localFiles && options.localFiles.length !== manifest.sources.length) {
      throw new InstallError(
        `this pack is built from ${manifest.sources.length} archive(s) but ${options.localFiles.length} file(s) were given`,
      );
    }
    for (const [index, source] of manifest.sources.entries()) {
      phase("download", { received: 0, ...(source.bytes ? { total: source.bytes } : {}) });
      const archivePath = join(txn, `archive-${index}.${source.archive.replace(".", "")}`);
      const onProgress = (progress: { received: number; total?: number }) =>
        phase("download", { received: progress.received, ...(progress.total ? { total: progress.total } : {}) });
      const local = options.localFiles?.[index];
      if (local) {
        await deps.importArchive(source, local, {
          destination: archivePath,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress,
        });
      } else {
        await deps.download(source, {
          destination: archivePath,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress,
        });
      }
      archives.push({ path: archivePath, format: source.archive });
    }

    phase("verify");
    // Each archive was hashed during its own download; reaching here means the
    // checksums matched.

    phase("extract");
    for (const archive of archives) {
      const names = await deps.list(archive.path, options.signal ? { signal: options.signal } : {});
      const plan = planExtraction(names);
      if (plan.violations.length > 0) {
        throw new InstallError(
          `the archive contains unsafe paths and was not extracted: ${plan.violations.slice(0, 5).join("; ")}`,
        );
      }
      await deps.extract(archive.path, archive.format, payloadStage, plan, options.signal ? { signal: options.signal } : {});
    }

    phase("inspect");
    const walk = deps.walk(payloadStage);
    if (walk.unsafe.length > 0) {
      throw new InstallError(`the archive contains symlinks pointing outside the pack: ${walk.unsafe.slice(0, 5).join("; ")}`);
    }
    if (walk.privileged.length > 0) {
      throw new InstallError(`the archive contains setuid/setgid files: ${walk.privileged.slice(0, 5).join("; ")}`);
    }
    if (walk.files === 0) {
      throw new InstallError("the archive extracted no files; it may be empty or in an unsupported format");
    }

    phase("validate");
    const validation = await deps.runValidation(payloadStage, manifest, options.signal ? { signal: options.signal } : {});
    if (!validation.ok) {
      throw new InstallError(validation.reason ?? `validation failed: ${validation.output.slice(0, 300)}`);
    }

    // ---- commit -----------------------------------------------------------
    phase("commit");
    const finalManifest: PackManifest = {
      ...manifest,
      installedAt: new Date().toISOString(),
      payload: {
        ...manifest.payload,
        files: walk.files,
        bytes: walk.bytes,
        treeHash: await deps.hashTree(payloadStage),
      },
    };
    // The manifest is written before the rename, so no observer ever sees a
    // pack directory without its record.
    writeManifest(txn, finalManifest);
    writeNotice(txn, finalManifest);

    mkdirSync(join(root, "packs"), { recursive: true });
    if (existsSync(destination)) {
      // Move the old pack aside first: the rename below needs the name free,
      // and a failure deleting the old one must not destroy the new one.
      const trash = join(root, "packs", `.trash-${id}-${Date.now()}`);
      await renameWithRetry(destination, trash);
      await renameWithRetry(txn, destination);
      try {
        rmSync(trash, { recursive: true, force: true });
      } catch {
        /* pruned later */
      }
    } else {
      await renameWithRetry(txn, destination);
    }

    return finalManifest;
  } finally {
    // Whatever happened, the transaction directory goes. On success it has
    // already been renamed into packs/<id>, so `existsSync` is false and there
    // is nothing to remove — deleting the destination would destroy the pack
    // that was just installed.
    try {
      if (txn && existsSync(txn)) rmSync(txn, { recursive: true, force: true });
    } catch {
      /* pruned later */
    }
    lock.release();
  }
}

/**
 * Windows 上刚解压出 1GB 的文件时，杀毒软件或索引器会立刻开始扫描，此时
 * 对目录改名会得到 EPERM。这不是真正的失败，等它扫完就好。
 *
 * 所以重试必须是异步的：同步的重试会把宿主的命令循环卡住最多一秒多，而这
 * 期间用户点什么都没有反应。
 */
async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      // Only transient Windows contention is worth waiting out. A permission
      // error caused by the target being a different volume will not improve.
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      if (attempt < attempts - 1) await sleep(120 * (attempt + 1));
    }
  }
  throw new InstallError(`could not move ${from} into place: ${last instanceof Error ? last.message : String(last)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The licence and source offer, written next to the payload. */
function writeNotice(packDirectory: string, manifest: PackManifest): void {
  const lines = [
    `${manifest.name} ${manifest.version}`,
    "",
    `Licence: ${manifest.license.name}`,
    `Licence text: ${manifest.license.url}`,
    ...(manifest.license.sourceUrl ? ["", `Corresponding source: ${manifest.license.sourceUrl}`] : []),
    "",
    "These programs are installed as separate executables and are invoked as child",
    "processes. They are not linked into Prometheus.",
    "",
    `Installed: ${manifest.installedAt}`,
    `Source archive: ${manifest.sources.map((source) => source.url).join("\n")}`,
  ];
  try {
    writeFileSync(join(packDirectory, "NOTICE.md"), lines.join("\n") + "\n");
  } catch {
    /* the notice is documentation; failing to write it must not fail the install */
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Install from a local `pack.json` plus its archive(s).
 *
 * This is the air-gapped path: a machine that cannot reach the vendor gets the
 * same transaction, the same member checks and the same validation — the only
 * difference is where the bytes came from. The checksum still comes from the
 * file the user supplied, so a mangled copy is caught rather than trusted.
 *
 * `localFiles` is optional. A `pack.json` with `sources` whose archives are
 * reachable still installs the normal way; this entry point exists so the UI
 * has one command for "the user handed us a file".
 */
export async function installFromManifest(
  manifestPath: string,
  options: InstallOptions & { localFiles?: string[] } = {},
): Promise<PackManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new InstallError(
      `could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        `An offline install needs the pack.json that came with the archive.`,
    );
  }
  const manifest = parseManifest(raw, manifestPath);
  return installPack({ manifest }, { ...options, allowUnverified: options.allowUnverified ?? false });
}

/** Directory size, without following symlinks. */
export function directoryBytes(dir: string): number {
  let total = 0;
  const visit = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) visit(full);
        else total += stat.size;
      } catch {
        /* vanished */
      }
    }
  };
  visit(dir);
  return total;
}
