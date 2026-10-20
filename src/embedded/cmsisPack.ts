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
import { execFileSync } from "node:child_process";
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
  /**
   * Package variants of this device (`STM32F429IGTx`, `STM32F429IGHx`).
   *
   * A project file names the variant, not the base device — Keil's
   * `TOUCH.uvprojx` says `<Device>STM32F429IGTx</Device>`. Looking one up by
   * the base name only would miss every real project.
   */
  aliases?: string[];
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
  // Keil keeps its own pack store, named by `RTEPATH` in TOOLS.INI, and it is
  // where an MDK user's device packs actually are. A machine with Keil
  // installed can have nothing in any of the roots above.
  roots.push(...keilPackRoots());
  return roots.filter((root, index, all) => all.indexOf(root) === index && existsSync(root));
}

/**
 * `TOOLS.INI` files Keil writes, in the order worth reading.
 *
 * The file sits beside `ARM\` and `UV4\` in the install root. The registry
 * names that root (`HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK\Path` =
 * `G:\software\keil5\ARM`), which is how an install outside `C:\Keil_v5` is
 * found — the same machine this was tested on. The default paths remain as
 * fallbacks for the common case.
 */
export function keilToolsIniPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.KEIL_TOOLS_INI) paths.push(env.KEIL_TOOLS_INI);
  for (const armPath of keilRegistryArmPaths()) {
    // The registry value is the `ARM` directory; TOOLS.INI is its parent's.
    paths.push(join(armPath, "..", "TOOLS.INI"));
  }
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programFiles86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  paths.push(
    join(programFiles, "Keil_v5", "TOOLS.INI"),
    join(programFiles, "Keil", "TOOLS.INI"),
    join(programFiles86, "Keil_v5", "TOOLS.INI"),
    "C:\\Keil_v5\\TOOLS.INI",
    "C:\\Keil\\TOOLS.INI",
  );
  return paths;
}

/** `...\Keil\Products\MDK\Path` from the registry, when the key exists. */
function keilRegistryArmPaths(): string[] {
  if (process.platform !== "win32") return [];
  if (cachedRegistryPaths) return cachedRegistryPaths;
  const paths: string[] = [];
  // `reg.exe` rather than a PowerShell command: it starts in a few
  // milliseconds, and this runs once per process.
  for (const key of [
    "HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\MDK",
    "HKLM\\SOFTWARE\\Keil\\Products\\MDK",
    "HKCU\\Software\\Keil\\Products\\MDK",
  ]) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // The value line is `    Path    REG_SZ    G:\software\keil5\ARM`.
      const match = /Path\s+REG_SZ\s+(.+)$/im.exec(out);
      if (match?.[1]?.trim()) paths.push(match[1].trim());
    } catch {
      /* the key does not exist, or reg is unavailable */
    }
  }
  cachedRegistryPaths = paths;
  return paths;
}

/** One lookup per process; the registry does not change mid-session. */
let cachedRegistryPaths: string[] | null = null;

/** Test seam. */
export function resetPackPathCache(): void {
  cachedRegistryPaths = null;
}

/**
 * The `RTEPATH` a TOOLS.INI names, or "" when it names none.
 *
 * The key is `RTEPATH="G:\software\keil5pack"` in the `[UV2]` section, quoted,
 * with no trailing separator. It is read rather than assumed because Keil lets
 * the user put its pack store anywhere, and this install does.
 */
export function parseRtePath(ini: string): string {
  // Only the `[UV2]` section's own key counts: a later section may repeat the
  // name for something else, and a commented line must not match.
  let section = "";
  for (const raw of String(ini ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toUpperCase();
      continue;
    }
    if (section !== "UV2") continue;
    const match = /^RTEPATH\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    return match[1].trim().replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

/** Pack stores named by any Keil install found on this machine. */
export function keilPackRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const ini of keilToolsIniPaths(env)) {
    try {
      if (!existsSync(ini)) continue;
      const rte = parseRtePath(readFileSync(ini, "utf8"));
      if (rte) roots.push(rte);
    } catch {
      /* an unreadable INI is not a failure worth reporting */
    }
  }
  return roots;
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
  // `<subFamily>` carries the SVD and the processor for every device in it, so
  // a device that declares neither of its own inherits the enclosing one. On a
  // real Keil DFP that is the normal shape: `STM32F429.svd` lives on
  // `subFamily DsubFamily="STM32F429"`, not on each of its 17 devices.
  const inherited = new Map<number, { svd?: string; processor?: string }>();
  const subfamilies = [...xml.matchAll(/<subFamily\b([^>]*)>([\s\S]*?)<\/subFamily>/g)];
  for (const sub of subfamilies) {
    if (sub.index === undefined) continue;
    const svd = /<debug\b[^>]*svd="([^"]+)"/.exec(sub[2])?.[1];
    const processor = /<processor\b[^>]*Pname="([^"]+)"/.exec(sub[2])?.[1];
    inherited.set(sub.index, {
      ...(svd ? { svd } : {}),
      ...(processor ? { processor } : {}),
    });
  }
  const inheritedFor = (index: number): { svd?: string; processor?: string } => {
    let best: { svd?: string; processor?: string } = {};
    for (const [at, value] of inherited) {
      if (at < index) best = value;
    }
    return best;
  };

  let match: RegExpExecArray | null;
  while ((match = blocks.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const dname = attr(attrs, "Dname") ?? attr(attrs, "Dvariant");
    if (!dname) continue;
    const vendor = attr(attrs, "Dvendor")?.split(":")[1] ?? undefined;
    const parent = inheritedFor(match.index ?? 0);
    const svd = /<debug\b[^>]*svd="([^"]+)"/.exec(body)?.[1] ?? parent.svd;
    const processor = /<processor\b[^>]*Pname="([^"]+)"/.exec(body)?.[1] ?? parent.processor;
    // Memory sizes come from `<memory>` elements; sizes are in hex or decimal
    // with a unit suffix, and a missing one is left undefined rather than 0.
    const memory = /<memory\b([^>]*)>/g;
    let mem: RegExpExecArray | null;
    let flash: number | undefined;
    let ram: number | undefined;
    while ((mem = memory.exec(body)) !== null) {
      const id = attr(mem[1], "id")?.toUpperCase();
      const name = attr(mem[1], "name")?.toUpperCase() ?? "";
      const size = parseSize(attr(mem[1], "size") ?? "");
      if (size === undefined) continue;
      // Keil's DFP names them `Flash` / `SRAM1` / `SRAM2` with no `id`, while
      // cpackget packs use `IROM1` / `IRAM1`. Both spellings are in the wild.
      if (id === "IROM1" || id === "ROM" || name === "FLASH") flash = Math.max(flash ?? 0, size);
      if (id === "IRAM1" || id === "RAM" || name.startsWith("SRAM")) ram = (ram ?? 0) + size;
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
      // `<variant Dvariant="STM32F429IGTx">` — the name a .uvprojx uses.
      ...(() => {
        const aliases = [...body.matchAll(/<variant\b[^>]*Dvariant="([^"]+)"/g)].map((entry) => entry[1]);
        return aliases.length > 0 ? { aliases } : {};
      })(),
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

/**
 * Every installed `.pdsc` under the pack roots, with its directory.
 *
 * Two layouts exist and both are in use:
 *
 *   root/<vendor>/<version>/<pack>.pdsc                      cpackget, Arm's own
 *   root/<vendor>/<packName>/<version>/<pack>.pdsc           Keil's RTEPATH
 *
 * Keil's is what an MDK install writes, and it is one level deeper. Only the
 * first was handled, so a Keil pack root produced zero packs even after it was
 * added to the search path.
 */
export function installedPacks(cwd = process.cwd()): { path: string; packDir: string }[] {
  const out: { path: string; packDir: string }[] = [];
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const pdscIn = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".pdsc"));
    } catch {
      return [];
    }
  };

  for (const root of packRoots(cwd)) {
    for (const vendor of subdirs(root)) {
      const vendorDir = join(root, vendor);
      for (const level of subdirs(vendorDir)) {
        const candidate = join(vendorDir, level);
        // `<vendor>/<version>` when the level itself holds the .pdsc.
        const here = pdscIn(candidate);
        if (here.length > 0) {
          for (const file of here) out.push({ path: join(candidate, file), packDir: candidate });
          continue;
        }
        // Otherwise `<vendor>/<packName>/<version>`.
        for (const version of subdirs(candidate)) {
          const packDir = join(candidate, version);
          for (const file of pdscIn(packDir)) out.push({ path: join(packDir, file), packDir });
        }
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
      devices.find((entry) => entry.aliases?.some((alias) => alias.toLowerCase() === device.toLowerCase())) ??
      devices.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, "") === needle) ??
      devices.find((entry) => entry.aliases?.some((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, "") === needle)) ??
      devices.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(needle)) ??
      // A variant whose base device is a prefix: `STM32F429IGT` → `STM32F429IG`,
      // the form Keil writes when it drops the package suffix.
      devices.find((entry) => entry.aliases?.some((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(needle)));
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
