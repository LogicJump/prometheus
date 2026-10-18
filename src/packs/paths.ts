/**
 * Where toolchain packs live, and what is allowed to be a pack id.
 *
 * The whole feature rests on one invariant: every byte it writes lives under
 * one root, and every pack is one directory that can be deleted with no
 * residue. This module owns the root and the id rules; nothing else computes a
 * path under it.
 *
 * The root is deliberately **not** `~/.prometheus`. That directory holds small
 * JSON that roams with a Windows profile and gets swept into backups; putting
 * multi-gigabyte compilers there would make every backup expensive and every
 * profile sync slow. The OS data directory is machine-local and user-writable,
 * so no admin rights and no `Program Files`.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** The environment variable that overrides the root, for CI and tests. */
export const ROOT_ENV = "PROMETHEUS_TOOLCHAIN_HOME";

/**
 * The directory every pack lives under.
 *
 * The override must be absolute: a relative value would resolve against
 * whatever directory the host happened to start in, which differs between the
 * CLI and the desktop app.
 */
export function packsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ROOT_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${ROOT_ENV} must be an absolute path, got "${override}". ` +
          `A relative path would resolve against the current directory, which differs between the CLI and the app.`,
      );
    }
    return normalize(override);
  }

  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) return join(local, "Prometheus", "toolchains");
    // A stripped environment with no LOCALAPPDATA: fall back to the profile
    // rather than failing, because a pack that cannot be installed is worse
    // than one installed in a slightly less ideal place.
    return join(homedir(), "AppData", "Local", "Prometheus", "toolchains");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Prometheus", "toolchains");
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "prometheus", "toolchains");
  return join(homedir(), ".local", "share", "prometheus", "toolchains");
}

/** Sub-directories under the root. Named so no caller builds them by hand. */
export function packsDir(root: string): string {
  return join(root, "packs");
}

export function tmpDir(root: string): string {
  return join(root, "tmp");
}

/** The directory a pack with this id installs to. */
export function packDir(root: string, id: string): string {
  assertPackId(id);
  return join(packsDir(root), id);
}

const GOOD_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A pack id is a directory name, so it has to be safe as one.
 *
 * The rules are deliberately narrow because the id appears in a path that gets
 * `rm -rf`'d on uninstall. Rejecting anything with a separator, a parent
 * reference or a drive letter is the difference between deleting one directory
 * and deleting something else.
 */
export function assertPackId(id: string): void {
  if (!id) throw new Error("pack id is empty");
  if (id.length > 64) throw new Error(`pack id is too long (${id.length} chars, max 64)`);
  if (id.includes("\0")) throw new Error("pack id contains a NUL byte");
  if (id.includes("/") || id.includes("\\")) throw new Error(`pack id must not contain a path separator: "${id}"`);
  if (id.includes(":") || id.includes("*") || id.includes("?") || id.includes('"') || id.includes("<") || id.includes(">") || id.includes("|")) {
    throw new Error(`pack id contains a character that is not allowed in a file name: "${id}"`);
  }
  if (id.startsWith(".") || id === "." || id === "..") {
    throw new Error(`pack id must not start with a dot or be a relative reference: "${id}"`);
  }
  if (!GOOD_ID.test(id)) {
    throw new Error(`pack id must be lowercase letters, digits, dot, dash or underscore: "${id}"`);
  }
}

/** True when `child` is `parent` or inside it. Lexical, on normalized paths. */
export function isInside(parent: string, child: string): boolean {
  const from = normalize(resolve(parent));
  const to = normalize(resolve(child));
  if (from === to) return true;
  // A trailing separator prevents `/a/bc` being treated as inside `/a/b`.
  const prefix = from.endsWith(sep) ? from : from + sep;
  // Windows paths are case-insensitive; comparing them case-sensitively would
  // report a path as outside its own directory when the drive letter differs.
  return process.platform === "win32" ? to.toLowerCase().startsWith(prefix.toLowerCase()) : to.startsWith(prefix);
}

/**
 * Create the root if it is missing and drop the ownership marker.
 *
 * The marker is what lets a destructive prune tell "a directory this app made"
 * from "a directory the user pointed us at by mistake". It is not a lock and
 * carries no data beyond its creation time.
 */
export function ensureRoot(root: string = packsRoot()): void {
  mkdirSync(packsDir(root), { recursive: true });
  mkdirSync(tmpDir(root), { recursive: true });
  const marker = join(root, "root.json");
  if (!existsSync(marker)) {
    try {
      writeFileSync(marker, JSON.stringify({ schema: 1, createdAt: new Date().toISOString() }, null, 2) + "\n");
    } catch {
      /* a read-only root fails later with a clearer message */
    }
  }
}

/** True when the root exists and carries the marker. */
export function isOwnedRoot(root: string): boolean {
  try {
    return statSync(join(root, "root.json")).isFile();
  } catch {
    return false;
  }
}
