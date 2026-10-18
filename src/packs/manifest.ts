/**
 * The record of one installed pack.
 *
 * `pack.json` lives inside the directory it describes. That single decision is
 * what makes uninstall safe and complete: there is no registry to fall out of
 * sync, no phantom entry after a hand-deleted directory, and no orphan after a
 * failed write. Deleting the directory deletes the record.
 *
 * Nothing here stores an absolute path. A pack installed at
 * `%LOCALAPPDATA%\Prometheus\toolchains` and later moved to a USB drive — or
 * reached through `PROMETHEUS_TOOLCHAIN_HOME` in CI — resolves identically.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "./paths.ts";

export type ArchiveFormat = "zip" | "tar.xz" | "tar.gz";

export interface PackSource {
  /** https only. */
  url: string;
  archive: ArchiveFormat;
  /** Lowercase hex, 64 characters. */
  sha256: string;
  bytes: number;
  /** Hosts a redirect may land on. The final response's host must be listed. */
  hosts: string[];
}

export interface PackLicense {
  name: string;
  url: string;
  /** Where the corresponding source can be obtained (GPL obligation). */
  sourceUrl?: string;
  /** The tools are invoked as child processes, never linked. */
  separateProcess: true;
}

export interface PackExecutable {
  /** Bare name, e.g. `arm-none-eabi-gcc`. */
  name: string;
  /** Path relative to the payload root. */
  path: string;
  toolchain?: string;
}

export interface PackValidation {
  /** Relative to the payload root. */
  command: string;
  args: string[];
  /** Regular expression the combined output must match. */
  expect: string;
}

export interface PackManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  provider: string;
  platform: string;
  arch: string;
  installedAt: string;
  sources: PackSource[];
  license: PackLicense;
  /** Toolchain kind names this pack satisfies, e.g. `["gcc-arm"]`. */
  provides: string[];
  executables: PackExecutable[];
  env: { pathPrepend: string[]; vars: Record<string, string> };
  validation: PackValidation;
  payload: { root: string; files: number; bytes: number; treeHash: string };
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function str(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackError(`${source}: "${field}" must be a non-empty string`);
  }
  return value;
}

function num(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PackError(`${source}: "${field}" must be a non-negative number`);
  }
  return value;
}

/** A relative path that stays inside its root. */
function safeRelative(value: unknown, field: string, source: string): string {
  const text = str(value, field, source);
  if (text.includes("\0")) throw new PackError(`${source}: "${field}" contains a NUL byte`);
  if (text.startsWith("/") || text.startsWith("\\")) {
    throw new PackError(`${source}: "${field}" must be relative, got "${text}"`);
  }
  if (/^[A-Za-z]:/.test(text)) throw new PackError(`${source}: "${field}" must not name a drive: "${text}"`);
  // Both separators: a manifest written on Windows may use backslashes, and
  // `..\..` is a traversal even though it has no forward slash.
  if (text.split(/[\\/]/).includes("..")) {
    throw new PackError(`${source}: "${field}" must not contain "..": "${text}"`);
  }
  return text.replace(/\\/g, "/");
}

/**
 * Validate a parsed `pack.json`.
 *
 * The checks exist because this file is read from disk and compared against
 * nothing else: if it says an executable lives at `..\..\evil.exe`, that is
 * where it would be run from. Everything is re-validated on read, not only on
 * write, since a pack directory can be edited by hand.
 */
export function parseManifest(raw: unknown, source = "pack.json"): PackManifest {
  if (!raw || typeof raw !== "object") throw new PackError(`${source}: expected an object`);
  const value = raw as Record<string, unknown>;

  if (value.schema !== 1) {
    // A higher schema is a pack made by a newer Prometheus. Say so rather than
    // guessing at its meaning — and never delete it.
    if (typeof value.schema === "number" && value.schema > 1) {
      throw new PackError(
        `${source}: this pack uses schema ${value.schema}, which this version of Prometheus does not understand. ` +
          `Update Prometheus rather than removing the pack.`,
      );
    }
    throw new PackError(`${source}: unsupported schema ${String(value.schema)}`);
  }

  const id = str(value.id, "id", source);
  if (!ID.test(id)) throw new PackError(`${source}: invalid id "${id}"`);

  const sourcesRaw = value.sources;
  if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
    throw new PackError(`${source}: "sources" must be a non-empty array`);
  }
  const sources: PackSource[] = sourcesRaw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const url = str(item.url, `sources[${index}].url`, source);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PackError(`${source}: sources[${index}].url is not a URL: "${url}"`);
    }
    if (parsed.protocol !== "https:") {
      throw new PackError(`${source}: sources[${index}].url must be https, got ${parsed.protocol}`);
    }
    const sha256 = str(item.sha256, `sources[${index}].sha256`, source).toLowerCase();
    if (!HASH.test(sha256)) {
      throw new PackError(`${source}: sources[${index}].sha256 must be 64 lowercase hex characters`);
    }
    const archive = str(item.archive, `sources[${index}].archive`, source);
    if (!["zip", "tar.xz", "tar.gz"].includes(archive)) {
      throw new PackError(`${source}: sources[${index}].archive must be zip, tar.xz or tar.gz`);
    }
    const hosts = Array.isArray(item.hosts) ? item.hosts.map((host) => String(host)) : [parsed.host];
    if (hosts.length === 0) throw new PackError(`${source}: sources[${index}].hosts must not be empty`);
    return {
      url,
      archive: archive as ArchiveFormat,
      sha256,
      bytes: num(item.bytes ?? 0, `sources[${index}].bytes`, source),
      hosts,
    };
  });

  const licenseRaw = (value.license ?? {}) as Record<string, unknown>;
  const license: PackLicense = {
    name: str(licenseRaw.name, "license.name", source),
    url: str(licenseRaw.url, "license.url", source),
    ...(typeof licenseRaw.sourceUrl === "string" ? { sourceUrl: licenseRaw.sourceUrl } : {}),
    separateProcess: true,
  };

  const provides = Array.isArray(value.provides) ? value.provides.map((entry) => String(entry)) : [];
  if (provides.length === 0) throw new PackError(`${source}: "provides" must list at least one toolchain kind`);

  const executablesRaw = value.executables;
  if (!Array.isArray(executablesRaw) || executablesRaw.length === 0) {
    throw new PackError(`${source}: "executables" must be a non-empty array`);
  }
  const executables: PackExecutable[] = executablesRaw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return {
      name: str(item.name, `executables[${index}].name`, source),
      path: safeRelative(item.path, `executables[${index}].path`, source),
      ...(typeof item.toolchain === "string" ? { toolchain: item.toolchain } : {}),
    };
  });

  const envRaw = (value.env ?? {}) as Record<string, unknown>;
  const env = {
    pathPrepend: Array.isArray(envRaw.pathPrepend)
      ? envRaw.pathPrepend.map((entry, index) => safeRelative(entry, `env.pathPrepend[${index}]`, source))
      : [],
    vars: typeof envRaw.vars === "object" && envRaw.vars ? Object.fromEntries(Object.entries(envRaw.vars).map(([key, entry]) => [key, String(entry)])) : {},
  };

  const validationRaw = (value.validation ?? {}) as Record<string, unknown>;
  const validation: PackValidation = {
    command: safeRelative(validationRaw.command, "validation.command", source),
    args: Array.isArray(validationRaw.args) ? validationRaw.args.map((entry) => String(entry)) : [],
    expect: str(validationRaw.expect, "validation.expect", source),
  };
  try {
    new RegExp(validation.expect);
  } catch {
    throw new PackError(`${source}: validation.expect is not a valid regular expression`);
  }

  const payloadRaw = (value.payload ?? {}) as Record<string, unknown>;
  const payload = {
    root: safeRelative(payloadRaw.root ?? "payload", "payload.root", source),
    files: num(payloadRaw.files ?? 0, "payload.files", source),
    bytes: num(payloadRaw.bytes ?? 0, "payload.bytes", source),
    treeHash: typeof payloadRaw.treeHash === "string" ? payloadRaw.treeHash : "",
  };

  return {
    schema: 1,
    id,
    name: str(value.name, "name", source),
    version: str(value.version, "version", source),
    provider: str(value.provider ?? "unknown", "provider", source),
    platform: str(value.platform ?? process.platform, "platform", source),
    arch: str(value.arch ?? process.arch, "arch", source),
    installedAt: typeof value.installedAt === "string" ? value.installedAt : new Date().toISOString(),
    sources,
    license,
    provides,
    executables,
    env,
    validation,
    payload,
  };
}

export function manifestPath(packDirectory: string): string {
  return join(packDirectory, "pack.json");
}

/** Read a pack's manifest, or null when it is missing or unreadable. */
export function readManifest(packDirectory: string): PackManifest | null {
  try {
    return parseManifest(JSON.parse(readFileSync(manifestPath(packDirectory), "utf8")), manifestPath(packDirectory));
  } catch {
    return null;
  }
}

/** Like `readManifest`, but reports why it failed. */
export function readManifestStrict(packDirectory: string): { manifest?: PackManifest; problem?: string } {
  try {
    const text = readFileSync(manifestPath(packDirectory), "utf8");
    return { manifest: parseManifest(JSON.parse(text), manifestPath(packDirectory)) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Write atomically: a reader never sees a half-written manifest. */
export function writeManifest(packDirectory: string, manifest: PackManifest): void {
  const target = manifestPath(packDirectory);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(temp, target);
}

/**
 * Resolve a relative path inside a pack, refusing anything that escapes it.
 *
 * This is the last line of defence for every path that came out of a manifest.
 */
export function resolvePayloadPath(packDirectory: string, manifest: PackManifest, relative: string): string {
  const base = join(packDirectory, manifest.payload.root);
  const target = join(base, relative);
  if (!isInside(base, target)) {
    throw new PackError(`"${relative}" resolves outside the pack payload (${target})`);
  }
  return target;
}
