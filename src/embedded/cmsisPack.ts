/**
 * CMSIS-Pack discovery.
 *
 * A CMSIS-Pack is the vendor-agnostic distribution format for everything a
 * debugger needs about a part: its SVD, its flash algorithm, its memory map
 * and its board descriptions. The format is published by Arm and implemented
 * by every major vendor, which is exactly why this is the generalisation the
 * project needs — one reader serves ST, Nordic, NXP, Renesas and the rest,
 * instead of a directory tree per vendor.
 *
 * This module implements the parts an agent actually uses:
 *
 *   index.pidx   the catalogue, fetched once and cached
 *   .pdsc        one pack's description, parsed on demand
 *   `$CMSIS_PACK_ROOT`  the local install, which has both already
 *
 * Downloading a pack is left to the user: `cpackget add` and the IDE install
 * both write the same layout, and a half-written pack is worse than none.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface PackDevice {
  /** Vendor:name, the key other tools use. */
  name: string;
  vendor?: string;
  processor?: string;
  /** `file.svd` relative to the pack root. */
  svd?: string;
  /** Flash size in bytes, from the device's memory elements. */
  flash?: number;
  ram?: number;
  /** Board ids this device is used on. */
  boards: string[];
  /** Documentation URLs the pack names (`<book>`, `<datasheet>`), verbatim. */
  docs?: string[];
  /** Where the description came from, so a result can cite it. */
  source: string;
}

export interface PackIndexEntry {
  vendor: string;
  name: string;
  version: string;
  url?: string;
  /** Installed directory, when the pack is present locally. */
  installedPath?: string;
}

/** The local CMSIS-Pack roots, most specific first. */
export function packRoots(cwd = process.cwd()): string[] {
  const roots: string[] = [];
  if (process.env.CMSIS_PACK_ROOT) roots.push(process.env.CMSIS_PACK_ROOT);
  const local = join(cwd, ".prometheus", "packs");
  if (existsSync(local)) roots.push(local);
  // The per-user location the official pack installer and cpackget use.
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) roots.push(join(home, ".cache", "arm", "packs"), join(home, "AppData", "Local", "Arm", "Packs"));
  return roots.filter((root, index, all) => all.indexOf(root) === index && existsSync(root));
}

/**
 * Parse `index.pidx`.
 *
 * The file is XML with one `<pdsc>` element per pack. Vendors mix self-closing
 * and paired tags, so the reader matches tags rather than assuming a shape.
 */
export function parsePidx(xml: string): PackIndexEntry[] {
  const entries: PackIndexEntry[] = [];
  const pattern = /<pdsc\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = match[1];
    const vendor = attr(attrs, "vendor");
    const name = attr(attrs, "name");
    if (!vendor || !name) continue;
    entries.push({
      vendor,
      name,
      version: attr(attrs, "version") ?? "0.0.0",
      ...(attr(attrs, "url") ? { url: attr(attrs, "url")! } : {}),
    });
  }
  return entries;
}

/** Read the index from the first root that has one. */
export function readPackIndex(cwd = process.cwd()): { entries: PackIndexEntry[]; source: string } | null {
  for (const root of packRoots(cwd)) {
    const file = join(root, ".Web", "index.pidx");
    const alternate = join(root, "index.pidx");
    const path = existsSync(file) ? file : existsSync(alternate) ? alternate : null;
    if (!path) continue;
    try {
      return { entries: parsePidx(readFileSync(path, "utf8")), source: path };
    } catch {
      /* an unreadable index is no index */
    }
  }
  return null;
}

/**
 * Parse one `.pdsc` into devices.
 *
 * Only the fields that answer "which SVD and how much memory" are extracted;
 * the schema is large and the rest is not something an agent can act on.
 */
export function parsePdsc(xml: string, source: string): PackDevice[] {
  const devices: PackDevice[] = [];
  const blocks = /<device\b([^>]*)>([\s\S]*?)<\/device>/g;
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const dname = attr(attrs, "Dname") ?? attr(attrs, "Dvariant");
    if (!dname) continue;
    const vendor = attr(attrs, "Dvendor")?.split(":")[1] ?? undefined;
    const svd = /<debug\b[^>]*svd="([^"]+)"/.exec(body)?.[1];
    const processor = /<processor\b[^>]*Pname="([^"]+)"/.exec(body)?.[1];
    // Memory sizes come from `<memory>` elements; sizes are in hex or decimal
    // with a unit suffix, and a missing one is left undefined rather than 0.
    const memory = /<memory\b([^>]*)>/g;
    let mem: RegExpExecArray | null;
    let flash: number | undefined;
    let ram: number | undefined;
    while ((mem = memory.exec(body)) !== null) {
      const id = attr(mem[1], "id")?.toUpperCase();
      const size = parseSize(attr(mem[1], "size") ?? "");
      if (size === undefined) continue;
      if (id === "IROM1" || id === "ROM") flash = (flash ?? 0) + size;
      if (id === "IRAM1" || id === "RAM") ram = (ram ?? 0) + size;
    }
    // A pack may point at the manual and the datasheet. Those URLs are the
    // one place a vendor states where the PDF lives, so they are kept as-is
    // and cited rather than guessed at from the part name.
    const docs: string[] = [];
    for (const key of ["datasheet", "book", "description"]) {
      const url = new RegExp(`<${key}[^>]*>\\s*(https?://[^<\\s]+)`, "i").exec(body)?.[1];
      if (url && !docs.includes(url)) docs.push(url);
    }
    devices.push({
      name: dname,
      ...(vendor ? { vendor } : {}),
      ...(docs.length > 0 ? { docs } : {}),
      ...(svd ? { svd } : {}),
      ...(processor ? { processor } : {}),
      ...(flash ? { flash } : {}),
      ...(ram ? { ram } : {}),
      boards: [],
      source,
    });
  }
  return devices;
}

/** `0x8000`, `32K`, `1M` — the forms the schema allows. */
export function parseSize(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = /^(0x[0-9a-f]+|\d+)\s*([KMG])?$/i.exec(trimmed);
  if (!match) return undefined;
  const base = match[1].toLowerCase().startsWith("0x") ? Number.parseInt(match[1], 16) : Number(match[1]);
  const scale = match[2]?.toUpperCase() === "G" ? 1024 ** 3 : match[2]?.toUpperCase() === "M" ? 1024 ** 2 : match[2]?.toUpperCase() === "K" ? 1024 : 1;
  return base * scale;
}

/** Every installed `.pdsc` under the pack roots, with its directory. */
export function installedPacks(cwd = process.cwd()): { path: string; packDir: string }[] {
  const out: { path: string; packDir: string }[] = [];
  for (const root of packRoots(cwd)) {
    let vendors: string[];
    try {
      vendors = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const vendor of vendors) {
      const vendorDir = join(root, vendor);
      let versions: string[];
      try {
        versions = readdirSync(vendorDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const version of versions) {
        const packDir = join(vendorDir, version);
        let files: string[];
        try {
          files = readdirSync(packDir).filter((name) => name.toLowerCase().endsWith(".pdsc"));
        } catch {
          continue;
        }
        for (const file of files) out.push({ path: join(packDir, file), packDir });
      }
    }
  }
  return out;
}

/**
 * Find the pack that describes a device, and with it the SVD.
 *
 * A vendor prefix match on the device name is the schema's own convention
 * (`STM32F429ZI` in `Keil.STM32F4xx_DFP`), so it finds the right pack without
 * a lookup table.
 */
export function findDeviceInPacks(device: string, cwd = process.cwd()): { device: PackDevice; svdPath?: string } | null {
  const needle = device.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const pack of installedPacks(cwd)) {
    let text: string;
    try {
      text = readFileSync(pack.path, "utf8");
    } catch {
      continue;
    }
    const devices = parsePdsc(text, pack.path);
    const hit =
      devices.find((entry) => entry.name.toLowerCase() === device.toLowerCase()) ??
      devices.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, "") === needle) ??
      devices.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(needle));
    if (!hit) continue;
    if (!hit.svd) return { device: hit };
    const svdPath = resolve(pack.packDir, hit.svd);
    return { device: hit, ...(existsSync(svdPath) ? { svdPath } : {}) };
  }
  return null;
}

/** A short citation for a result: the pack file and the relative path. */
export function citePack(device: PackDevice, cwd = process.cwd()): string {
  return `${relative(cwd, device.source) || device.source}`;
}

function attr(text: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(text);
  return match ? match[1] : undefined;
}
