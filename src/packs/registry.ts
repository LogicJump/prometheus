/**
 * What is installed, whether it still works, and getting rid of it.
 *
 * The directory listing is the index. There is no `packs.json` to fall out of
 * sync, which means the two failure modes such a file normally has — a phantom
 * entry after a hand-deleted directory, and an orphan after a failed write —
 * cannot happen here.
 *
 * Uninstall renames before it deletes. On Windows a file inside the pack may be
 * open (a debugger holding a binary, an antivirus scanning it), and a delete
 * that fails halfway leaves a directory that looks installed. Renaming first
 * makes the pack disappear from the list immediately and definitively; the
 * bytes go when the handle does.
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { treeHash, walkStats } from "./archive.ts";
import { readManifest, readManifestStrict, type PackManifest } from "./manifest.ts";
import { packsDir, packsRoot, tmpDir } from "./paths.ts";
import { directoryBytes, freeBytes, runValidation, type PackProgress } from "./install.ts";

export type PackStatus = "ok" | "broken";

export interface InstalledPack {
  manifest: PackManifest;
  dir: string;
  /** Total bytes on disk, including the payload. */
  bytes: number;
  status: PackStatus;
  /** Why it is broken, when it is. */
  problem?: string;
}

/**
 * Every pack in the root, cheapest checks only.
 *
 * A pack whose manifest is missing or unparseable is reported as broken with
 * its directory name — never silently skipped, because a directory the user
 * cannot see is a directory they cannot clean up.
 */
export function listPacks(root: string = packsRoot()): InstalledPack[] {
  const base = packsDir(root);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }

  const packs: InstalledPack[] = [];
  for (const name of names) {
    // `.trash-*` directories are pending deletions, not packs.
    if (name.startsWith(".")) continue;
    const dir = join(base, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const { manifest, problem } = readManifestStrict(dir);
    if (!manifest) {
      packs.push({
        manifest: {
          schema: 1,
          id: name,
          name,
          version: "unknown",
          provider: "unknown",
          platform: process.platform,
          arch: process.arch,
          installedAt: "",
          sources: [],
          license: { name: "unknown", url: "", separateProcess: true },
          provides: [],
          executables: [],
          env: { pathPrepend: [], vars: {} },
          validation: { command: "", args: [], expect: "" },
          payload: { root: "payload", files: 0, bytes: 0, treeHash: "" },
        },
        dir,
        bytes: directoryBytes(dir),
        status: "broken",
        problem: problem ?? "pack.json is missing",
      });
      continue;
    }

    const payload = join(dir, manifest.payload.root);
    const payloadProblem = existsSync(payload) ? undefined : `payload directory ${manifest.payload.root} is missing`;
    packs.push({
      manifest,
      dir,
      bytes: directoryBytes(dir),
      status: payloadProblem ? "broken" : "ok",
      ...(payloadProblem ? { problem: payloadProblem } : {}),
    });
  }

  return packs.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * Re-check a pack.
 *
 * The shallow check is what the UI can afford on demand: the executables exist
 * and the toolchain still answers. The deep check re-hashes the whole payload —
 * correct, and minutes of I/O on a multi-gigabyte toolchain — so it is only
 * ever explicit.
 */
export async function verifyPack(
  id: string,
  options: { root?: string; deep?: boolean; signal?: AbortSignal; onProgress?: (progress: PackProgress) => void } = {},
): Promise<{ ok: boolean; problems: string[] }> {
  const root = options.root ?? packsRoot();
  const dir = join(packsDir(root), id);
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, problems: [`${id}: pack.json is missing or unreadable`] };

  const problems: string[] = [];
  const payload = join(dir, manifest.payload.root);
  if (!existsSync(payload)) {
    return { ok: false, problems: [`${id}: payload directory is missing`] };
  }

  for (const executable of manifest.executables) {
    const full = join(payload, executable.path);
    if (!existsSync(full)) problems.push(`${executable.name} is missing (${executable.path})`);
  }

  const walk = walkStats(payload);
  if (manifest.payload.files > 0 && walk.files !== manifest.payload.files) {
    problems.push(`expected ${manifest.payload.files} files, found ${walk.files}`);
  }
  if (walk.unsafe.length > 0) problems.push(`${walk.unsafe.length} symlink(s) point outside the pack`);

  if (problems.length === 0) {
    const validation = await runValidation(payload, manifest, options.signal ? { signal: options.signal } : {});
    if (!validation.ok) problems.push(validation.reason ?? "the toolchain no longer runs");
  }

  if (options.deep && problems.length === 0 && manifest.payload.treeHash) {
    options.onProgress?.({ id, phase: "verify", message: "hashing payload" });
    const hash = await treeHash(payload);
    if (hash !== manifest.payload.treeHash) {
      problems.push(`payload hash changed (expected ${manifest.payload.treeHash.slice(0, 19)}…, got ${hash.slice(0, 19)}…)`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Remove a pack.
 *
 * Renamed out of `packs/` first so the pack stops existing as far as everything
 * else is concerned, then deleted. If the delete fails — a locked file on
 * Windows — the trash directory is left for `pruneTmp`.
 */
export async function removePack(id: string, options: { root?: string } = {}): Promise<void> {
  const root = options.root ?? packsRoot();
  const dir = join(packsDir(root), id);
  if (!existsSync(dir)) return;

  const trash = join(packsDir(root), `.trash-${id}-${Date.now()}`);
  renameSync(dir, trash);
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {
    /* a locked file: the pack is already invisible; prune retries */
  }
}

/**
 * Delete leftovers: abandoned transactions and trash directories.
 *
 * Only directories this app created, and only when they are old enough that no
 * install could still be using them. An in-flight transaction is protected by
 * its age, since a real install never takes a day.
 */
export async function pruneTmp(
  options: { root?: string; txnOlderThanMs?: number; trashOlderThanMs?: number } = {},
): Promise<{ removed: string[]; bytes: number }> {
  const root = options.root ?? packsRoot();
  const txnAge = options.txnOlderThanMs ?? 24 * 60 * 60 * 1000;
  const trashAge = options.trashOlderThanMs ?? 60 * 60 * 1000;
  const removed: string[] = [];
  let bytes = 0;

  const sweep = (dir: string, prefix: string, maxAge: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      let age = 0;
      let size = 0;
      try {
        age = Date.now() - statSync(full).mtimeMs;
        size = directoryBytes(full);
      } catch {
        continue;
      }
      if (age < maxAge) continue;
      try {
        rmSync(full, { recursive: true, force: true });
        removed.push(full);
        bytes += size;
      } catch {
        /* try again next time */
      }
    }
  };

  sweep(tmpDir(root), "txn-", txnAge);
  sweep(packsDir(root), ".trash-", trashAge);
  return { removed, bytes };
}

export interface PacksSummary {
  root: string;
  packs: InstalledPack[];
  totalBytes: number;
  freeBytes: number | null;
}

/** What the settings page shows: where the space went, and how much is left. */
export function packsSummary(root: string = packsRoot()): PacksSummary {
  const packs = listPacks(root);
  return {
    root,
    packs,
    totalBytes: packs.reduce((sum, pack) => sum + pack.bytes, 0),
    freeBytes: freeBytes(existsSync(root) ? root : process.cwd()),
  };
}

/** The `bin` directories a set of packs contributes, keyed by toolchain kind. */
export function packBinDirs(root: string = packsRoot()): Map<string, { dir: string; packId: string }[]> {
  const map = new Map<string, { dir: string; packId: string }[]>();
  for (const pack of listPacks(root)) {
    if (pack.status !== "ok") continue;
    for (const entry of pack.manifest.env.pathPrepend) {
      // `pathPrepend` entries are relative to the **pack** directory, so
      // `payload/bin` means `<pack>/payload/bin` — not `<pack>/payload/payload/bin`.
      const dir = join(pack.dir, entry);
      // A `provides` entry may name one of several executables the pack
      // installs, not the directory's own name. probe-rs ships `probe-rs.exe`,
      // `cargo-flash.exe` and `cargo-embed.exe` together and declares
      // `provides: ["probe-rs"]`, but `esptool`'s release declares
      // `provides: ["esptool"]` while the detection spec also looks for
      // `esptool.py` — mapping by `provides` alone is right either way. The
      // executable list is consulted first so a pack that provides a kind
      // under an executable name is still found.
      const provided = new Set(pack.manifest.provides);
      for (const executable of pack.manifest.executables) {
        if (executable.toolchain) provided.add(executable.toolchain);
      }
      for (const kind of provided) {
        const list = map.get(kind) ?? [];
        if (!list.some((hit) => hit.dir === dir && hit.packId === pack.manifest.id)) list.push({ dir, packId: pack.manifest.id });
        map.set(kind, list);
      }
    }
  }
  return map;
}
