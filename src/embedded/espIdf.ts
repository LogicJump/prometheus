/**
 * ESP-IDF's `flasher_args.json`.
 *
 * The build directory of an ESP-IDF project contains a machine-readable
 * description of exactly what to flash and where: the bootloader, the
 * partition table and the application, each with its offset and its
 * `flash_args` array. Reading it is what makes `embed_flash` correct on ESP32
 * without the agent having to know a single ESP-specific offset.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface EspImage {
  path: string;
  offset: number;
}

export interface EspFlashPlan {
  /** The json file it came from. */
  source: string;
  images: EspImage[];
  /** The project's build directory, so relative paths resolve against it. */
  buildDir: string;
  /** The chip the build targeted, when the file names one. */
  chip?: string;
}

/**
 * Read `flasher_args.json` from a build directory.
 *
 * Two shapes exist: the flat `{ "flash_files": {"0x0": "bootloader/..."} }`
 * emitted by older IDF versions, and the `{ "flash_files": [...] }` array of
 * newer ones. Both are accepted; anything else is reported as a shape this
 * parser does not know rather than silently flashing one file.
 */
export function readFlasherArgs(buildDir: string): EspFlashPlan | string | null {
  const file = join(buildDir, "flasher_args.json");
  if (!existsSync(file)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return `could not parse ${file}: ${(err as Error).message}`;
  }
  const images: EspImage[] = [];
  const base = dirname(file);
  const resolvePath = (value: string): string => (isAbsolute(value) ? value : resolve(base, value));

  const files = parsed.flash_files;
  if (files && typeof files === "object" && !Array.isArray(files)) {
    for (const [offset, path] of Object.entries(files as Record<string, unknown>)) {
      if (typeof path !== "string") continue;
      const value = Number.parseInt(offset, 16);
      if (!Number.isFinite(value)) continue;
      images.push({ path: resolvePath(path), offset: value });
    }
  } else if (Array.isArray(files)) {
    // Newer shape: entries carry their own offset.
    for (const entry of files) {
      const record = entry as { path?: unknown; offset?: unknown };
      if (typeof record.path !== "string") continue;
      const value = typeof record.offset === "number" ? record.offset : Number.parseInt(String(record.offset ?? "0x0"), 16);
      if (!Number.isFinite(value)) continue;
      images.push({ path: resolvePath(record.path), offset: value });
    }
  } else {
    return `${file} has no flash_files this parser understands; flash the files it names by hand`;
  }

  if (images.length === 0) return `${file} lists no images`;
  // A stable order makes the command reproducible and the transcript readable.
  images.sort((a, b) => a.offset - b.offset);
  const chip = typeof parsed.extra_esptool_args === "object" && parsed.extra_esptool_args
    ? String((parsed.extra_esptool_args as Record<string, unknown>).chip ?? "") || undefined
    : undefined;
  return { source: file, images, buildDir: base, ...(chip ? { chip } : {}) };
}

/** Find a build directory that has a flasher_args.json, near a firmware path. */
export function findFlasherArgs(firmware: string): EspFlashPlan | string | null {
  let dir = dirname(resolve(firmware));
  for (let depth = 0; depth < 4; depth++) {
    const plan = readFlasherArgs(dir);
    if (plan !== null) return plan;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
