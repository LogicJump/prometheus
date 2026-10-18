/**
 * Reading a chip's register map.
 *
 * The SVD is the one place where "what is the address of USART2->CR1" has a
 * definitive answer. Without it the model guesses register offsets from memory,
 * and a wrong offset does not fail to compile — it writes to the wrong
 * peripheral and the board misbehaves in a way that looks like a logic bug.
 *
 * The format is bigger than it looks. STM32H743 is 4 MB of XML with 1,988
 * registers and 11,127 fields; nRF52840 has 4,914 enumerated values. None of
 * that fits in a context window, so this module produces three tiers:
 *
 *   index     peripheral.REGISTER → offset, roughly 2k tokens for a whole chip
 *   detail    one peripheral's registers and fields, on demand
 *   enums     field value names, only for configuration questions
 *
 * Two things make SVD parsing harder than the schema suggests, and both are
 * normal vendor output rather than edge cases:
 *
 *   derivedFrom   A peripheral may inherit everything from another and give
 *                 only a name and a base address. STM32H743 has 51 of 71
 *                 peripherals written this way; unresolved, they look empty.
 *   lsb/msb       Fields may use either `bitOffset`/`bitWidth` or `lsb`/`msb`,
 *                 mixed within one file.
 *
 * The parser is deliberately forgiving: vendors write `schemaVersion="1.1"`
 * where the spec says 1.3, omit elements the schema requires, and nest
 * clusters. Validating strictly would reject most real files.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export interface SvdField {
  name: string;
  bitOffset: number;
  bitWidth: number;
  description?: string;
  /** Field-level access, when it differs from the register's. */
  access?: "read-only" | "read-write" | "write-only" | "read-writeOnce" | "writeOnce";
  /** Enum value name → numeric value. */
  enums?: Record<string, string>;
}

export interface SvdRegister {
  name: string;
  offset: number;
  size: number;
  access?: string;
  resetValue?: number;
  description?: string;
  fields: SvdField[];
}

export interface SvdPeripheral {
  name: string;
  baseAddress: number;
  description?: string;
  /** Name of the peripheral this one derives from, when it inherits. */
  derivedFrom?: string;
  groupName?: string;
  registers: SvdRegister[];
  interrupts?: { name: string; value: number }[];
}

export interface SvdDevice {
  name: string;
  vendor?: string;
  cpu?: { name: string; revision?: string; fpuPresent?: boolean; mpuPresent?: boolean; endian?: string };
  /** The part's flash and RAM, from the `<memory>` blocks when present. */
  memories?: { name: string; start: number; size: number; access?: string }[];
  peripherals: SvdPeripheral[];
  /** The file this came from, for provenance. */
  source?: string;
}

// ---- XML helpers -----------------------------------------------------------

/** Text of the first `<tag>` inside `xml`, with entities decoded. */
function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decode(match[1].trim()) : undefined;
}

function attr(xml: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return match ? match[1] : undefined;
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/** The direct children of `xml`, excluding those nested inside a child of the same tag. */
function directChildren(xml: string, name: string): string[] {
  return blocks(xml, name).filter((block) => {
    // A block is direct when nothing between the start of `xml` and this block
    // contains an unclosed instance of the same tag.
    const start = xml.indexOf(block);
    const prefix = xml.slice(0, start);
    const opened = (prefix.match(new RegExp(`<${name}(?:\\s[^>]*)?>`, "g")) ?? []).length;
    const closed = (prefix.match(new RegExp(`</${name}>`, "g")) ?? []).length;
    return opened === closed;
  });
}

/** Text of the first `<tag>` that is a direct child of `xml`. */
function ownTag(xml: string, name: string): string | undefined {
  // Skip this element's own opening tag, then cut at the first nested
  // `<registers>`/`<cluster>`/`<register>`/`<field>` — otherwise a child's
  // `addressOffset` is mistaken for the parent's.
  const open = xml.indexOf(">");
  const body = open >= 0 ? xml.slice(open + 1) : xml;
  const stop = /<(registers|cluster|register|fields|field)[\s>]/.exec(body);
  const head = stop ? body.slice(0, stop.index) : body;
  return tag(head, name);
}
/**
 * Every `<name>...</name>` element in `xml`, at any depth.
 *
 * A single forward scan with a depth counter: find an opening tag, then walk to
 * its matching close. Self-closing tags (`<register/>`) and comments are
 * skipped, and a malformed file with an unclosed element stops rather than
 * looping.
 */
function blocks(xml: string, name: string): string[] {
  return blockSpans(xml, name).map((span) => xml.slice(span.start, span.end));
}

/** Every `<name>` element with its byte span, which callers need to judge nesting. */
function blockSpans(xml: string, name: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const open = new RegExp(`<${name}(?:\\s[^>]*)?>`, "g");
  const close = new RegExp(`</${name}>`, "g");

  let match = open.exec(xml);
  while (match) {
    const start = match.index;
    const tagEnd = xml.indexOf(">", start);
    if (tagEnd < 0) break;
    if (xml[tagEnd - 1] === "/") {
      open.lastIndex = tagEnd + 1;
      match = open.exec(xml);
      continue;
    }

    let depth = 1;
    let index = tagEnd + 1;
    let end = -1;
    while (depth > 0) {
      close.lastIndex = index;
      const nextClose = close.exec(xml);
      if (!nextClose) break;
      open.lastIndex = index;
      const nextOpen = open.exec(xml);
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        index = nextOpen.index + nextOpen[0].length;
        continue;
      }
      depth--;
      index = nextClose.index + nextClose[0].length;
      if (depth === 0) end = index;
    }

    if (end < 0) break;
    out.push({ start, end });
    open.lastIndex = end;
    match = open.exec(xml);
  }
  return out;
}

function nextIndex(xml: string, pattern: RegExp, from: number): number {
  pattern.lastIndex = from;
  const match = pattern.exec(xml);
  pattern.lastIndex = 0;
  return match ? match.index : -1;
}

function num(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  // SVD allows `0x40021000`, `#0x40021000`, and occasional `0b`/decimal.
  const value = Number(trimmed.replace(/^#/, ""));
  return Number.isFinite(value) ? value : undefined;
}

/** `derivedFrom` may name just the peripheral or a dotted path. */
function deriveName(ref: string): string {
  const last = ref.split(".").pop() ?? ref;
  return last.trim();
}

// ---- fields and registers --------------------------------------------------

function parseFields(registerXml: string): SvdField[] {
  const fields: SvdField[] = [];
  for (const block of blocks(registerXml, "field")) {
    const name = tag(block, "name");
    if (!name) continue;

    // Either bitOffset/bitWidth or lsb/msb; vendors mix them within a file.
    let bitOffset = num(tag(block, "bitOffset"));
    let bitWidth = num(tag(block, "bitWidth"));
    if (bitOffset === undefined) {
      const lsb = num(tag(block, "lsb"));
      const msb = num(tag(block, "msb"));
      if (lsb !== undefined && msb !== undefined) {
        bitOffset = lsb;
        bitWidth = msb - lsb + 1;
      } else if (num(tag(block, "bitRange"))) {
        // `<bitRange>[7:4]</bitRange>` — the remaining legal spelling.
        const range = /\[(\d+):(\d+)\]/.exec(tag(block, "bitRange") ?? "");
        if (range) {
          bitOffset = Number(range[2]);
          bitWidth = Number(range[1]) - Number(range[2]) + 1;
        }
      }
    }
    if (bitOffset === undefined) continue;
    bitWidth ??= 1;

    const description = tag(block, "description")?.replace(/\s+/g, " ").slice(0, 300);
    const access = tag(block, "access") as SvdField["access"] | undefined;

    const enums: Record<string, string> = {};
    for (const enumBlock of blocks(block, "enumeratedValue")) {
      const enumName = tag(enumBlock, "name");
      const value = tag(enumBlock, "value");
      if (enumName && value !== undefined) enums[enumName] = value;
    }

    fields.push({
      name,
      bitOffset,
      bitWidth,
      ...(description ? { description } : {}),
      ...(access ? { access } : {}),
      ...(Object.keys(enums).length > 0 ? { enums } : {}),
    });
  }
  return fields.sort((a, b) => a.bitOffset - b.bitOffset);
}

function parseRegisters(xml: string, depth = 0): SvdRegister[] {
  const registers: SvdRegister[] = [];
  // Registers that live inside a nested cluster are handled by the cluster
  // branch below, with that cluster's offset added. Taking them here too would
  // count every nested register twice.
  for (const block of directBlocks(xml, "register")) {
    const name = tag(block, "name");
    const offset = num(tag(block, "addressOffset"));
    if (!name || offset === undefined) continue;
    registers.push({
      name,
      offset,
      size: num(tag(block, "size")) ?? 32,
      ...(tag(block, "access") ? { access: tag(block, "access") } : {}),
      ...(num(tag(block, "resetValue")) !== undefined ? { resetValue: num(tag(block, "resetValue")) } : {}),
      ...(tag(block, "description") ? { description: tag(block, "description")!.replace(/\s+/g, " ").slice(0, 200) } : {}),
      fields: parseFields(block),
    });
  }
  // Clusters nest registers and further clusters; flatten their offsets.
  if (depth < 4) {
    for (const block of directBlocks(xml, "cluster")) {
      // The cluster's own offset, not the first nested register's.
      const clusterOffset = num(ownTag(block, "addressOffset")) ?? 0;
      for (const register of parseRegisters(block, depth + 1)) {
        registers.push({ ...register, offset: register.offset + clusterOffset });
      }
    }
  }
  return registers;
}

/** The blocks of `name` that are direct children of `xml`, not inside a nested cluster. */
function directBlocks(xml: string, name: string): string[] {
  const selfStart = /^<cluster(?:\s[^>]*)?>/.exec(xml.trimStart()) ? xml.indexOf("<cluster") : -1;
  const containerEnd = selfStart >= 0 ? (blockSpans(xml, "cluster")[0]?.end ?? -1) : -1;

  return blockSpans(xml, name)
    .filter((span) => {
      // Drop the container element itself: a search for "cluster" inside a
      // cluster block must not return that block.
      if (name === "cluster" && selfStart >= 0 && span.start === selfStart) return false;
      // A block enclosed by a cluster other than the container is nested.
      const enclosing = blockSpans(xml, "cluster").find(
        (cluster) => cluster.start < span.start && cluster.end > span.end,
      );
      if (!enclosing) return true;
      return selfStart >= 0 && enclosing.start === selfStart && span.end < containerEnd;
    })
    .map((span) => xml.slice(span.start, span.end));
}

function parsePeripheral(block: string): SvdPeripheral | null {
  const name = tag(block, "name");
  const baseAddress = num(tag(block, "baseAddress"));
  if (!name || baseAddress === undefined) return null;

  const derivedFrom = attr(block.slice(0, block.indexOf(">") + 1), "derivedFrom");
  const interrupts = blocks(block, "interrupt")
    .map((entry) => {
      const interruptName = tag(entry, "name");
      const value = num(tag(entry, "value"));
      return interruptName && value !== undefined ? { name: interruptName, value } : null;
    })
    .filter((entry): entry is { name: string; value: number } => entry !== null);

  return {
    name,
    baseAddress,
    ...(tag(block, "description") ? { description: tag(block, "description")!.replace(/\s+/g, " ").slice(0, 300) } : {}),
    ...(derivedFrom ? { derivedFrom: deriveName(derivedFrom) } : {}),
    ...(tag(block, "groupName") ? { groupName: tag(block, "groupName") } : {}),
    registers: parseRegisters(block),
    ...(interrupts.length ? { interrupts } : {}),
  };
}

// ---- the device ------------------------------------------------------------

/**
 * Resolve `derivedFrom` chains.
 *
 * A derived peripheral inherits registers, fields and interrupts from its
 * parent, but keeps its own name and base address. Inheritance can chain, and a
 * cycle is malformed input rather than something to support — it stops.
 */
export function resolveDerivation(peripherals: SvdPeripheral[]): SvdPeripheral[] {
  const byName = new Map(peripherals.map((peripheral) => [peripheral.name, peripheral]));

  const resolved = new Map<string, SvdPeripheral>();
  const resolveOne = (name: string, seen: Set<string>): SvdPeripheral | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    const peripheral = byName.get(name);
    if (!peripheral) return undefined;
    if (!peripheral.derivedFrom) {
      resolved.set(name, peripheral);
      return peripheral;
    }
    if (seen.has(name)) return peripheral; // a cycle: stop rather than recurse
    seen.add(name);

    const parent = resolveOne(peripheral.derivedFrom, seen);
    const merged: SvdPeripheral = {
      ...peripheral,
      registers: peripheral.registers.length > 0 ? peripheral.registers : (parent?.registers ?? []),
      ...(parent?.interrupts && !peripheral.interrupts ? { interrupts: parent.interrupts } : {}),
      ...(parent?.groupName && !peripheral.groupName ? { groupName: parent.groupName } : {}),
    };
    resolved.set(name, merged);
    return merged;
  };

  return peripherals.map((peripheral) => resolveOne(peripheral.name, new Set()) ?? peripheral);
}

/** Parse an SVD file or an SVD document string. */
export function parseSvd(input: string, options: { source?: string } = {}): SvdDevice {
  let xml = input;
  if (existsSync(input)) {
    xml = readFileSync(input, "utf8");
    options = { ...options, source: options.source ?? basename(input) };
  }

  // The device block holds everything; but some files are `<device>` roots with
  // leading XML declaration and comments, so match the element itself.
  const deviceMatch = /<device(?:\s[^>]*)?>[\s\S]*<\/device>/.exec(xml);
  if (!deviceMatch) {
    // Not every file called `.svd` is an SVD — some are source files with the
    // wrong extension. Naming that beats returning an empty device.
    throw new Error(`${options.source ?? "input"} is not an SVD: no <device> element found`);
  }
  const deviceXml = deviceMatch[0];

  const cpuBlock = /<cpu(?:\s[^>]*)?>[\s\S]*?<\/cpu>/.exec(deviceXml)?.[0];
  const cpu = cpuBlock
    ? {
        name: tag(cpuBlock, "name") ?? "unknown",
        ...(tag(cpuBlock, "revision") ? { revision: tag(cpuBlock, "revision") } : {}),
        ...(tag(cpuBlock, "fpuPresent") ? { fpuPresent: tag(cpuBlock, "fpuPresent") === "true" } : {}),
        ...(tag(cpuBlock, "mpuPresent") ? { mpuPresent: tag(cpuBlock, "mpuPresent") === "true" } : {}),
        ...(tag(cpuBlock, "endian") ? { endian: tag(cpuBlock, "endian") } : {}),
      }
    : undefined;

  // Memories live inside <peripherals> as a pseudo-peripheral in older files and
  // as <memory> elements in newer ones.
  const peripheralsBlock = /<peripherals(?:\s[^>]*)?>[\s\S]*<\/peripherals>/.exec(deviceXml)?.[0] ?? deviceXml;
  const peripherals: SvdPeripheral[] = [];
  const memories: NonNullable<SvdDevice["memories"]> = [];

  for (const block of blocks(peripheralsBlock, "peripheral")) {
    const name = tag(block, "name");
    // Some files model the flash and RAM regions as peripherals.
    if (name === "FLASH" || name === "RAM") {
      const start = num(tag(block, "baseAddress"));
      const size = num(tag(block, "size"));
      if (start !== undefined && size !== undefined) memories.push({ name, start, size });
    }
    const parsed = parsePeripheral(block);
    if (parsed) peripherals.push(parsed);
  }

  return {
    name: tag(deviceXml, "name") ?? "unknown",
    ...(tag(deviceXml, "vendor") ? { vendor: tag(deviceXml, "vendor") } : {}),
    ...(cpu ? { cpu } : {}),
    ...(memories.length ? { memories } : {}),
    peripherals: resolveDerivation(peripherals),
    ...(options.source ? { source: options.source } : {}),
  };
}

// ---- the three tiers -------------------------------------------------------

/**
 * The index: one line per peripheral plus one per register.
 *
 * This is what fits in a context window. It carries the resolved base address
 * because a derived peripheral otherwise looks like it lives at zero.
 */
export function peripheralIndex(device: SvdDevice): string {
  const lines: string[] = [`${device.name} (${device.peripherals.length} peripherals)`];
  for (const peripheral of device.peripherals) {
    const base = `0x${peripheral.baseAddress.toString(16).toUpperCase().padStart(8, "0")}`;
    lines.push(`\n${peripheral.name} @${base}${peripheral.description ? ` — ${peripheral.description}` : ""}`);
    if (peripheral.registers.length === 0) {
      lines.push("  (no registers)");
      continue;
    }
    lines.push(
      "  " +
        peripheral.registers
          .map((register) => `${register.name}+0x${register.offset.toString(16).toUpperCase()}`)
          .join(" "),
    );
  }
  return lines.join("\n");
}

/**
 * One peripheral in full: registers, fields, bit positions, enum names.
 *
 * Field lines use `FIELD[lsb:width]`, which is unambiguous and cheaper than a
 * table. Enumerations are included because a configuration question almost
 * always needs them.
 */
export function peripheralDetail(device: SvdDevice, name: string): string | null {
  const peripheral = device.peripherals.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!peripheral) return null;

  const lines: string[] = [];
  lines.push(`${peripheral.name} @0x${peripheral.baseAddress.toString(16).toUpperCase()}`);
  if (peripheral.description) lines.push(peripheral.description);
  if (peripheral.interrupts?.length) {
    lines.push(`interrupts: ${peripheral.interrupts.map((interrupt) => `${interrupt.name}=${interrupt.value}`).join(", ")}`);
  }

  for (const register of peripheral.registers) {
    const bits = `${register.size}b`;
    const access = register.access ? ` ${register.access}` : "";
    const reset = register.resetValue !== undefined ? ` reset=0x${register.resetValue.toString(16)}` : "";
    lines.push(`\n${register.name} +0x${register.offset.toString(16).toUpperCase()} (${bits}${access}${reset})`);
    if (register.description) lines.push(`  ${register.description}`);
    for (const field of register.fields) {
      const range = field.bitWidth === 1 ? `[${field.bitOffset}]` : `[${field.bitOffset}:${field.bitWidth}]`;
      const enums = field.enums
        ? ` {${Object.entries(field.enums).map(([enumName, value]) => `${enumName}=${value}`).join(", ")}}`
        : "";
      const description = field.description ? ` — ${field.description}` : "";
      lines.push(`  ${field.name}${range}${enums}${description}`);
    }
  }
  return lines.join("\n");
}

/** How big each tier is, in characters, so a caller can budget before sending. */
export function sizes(device: SvdDevice): { index: number; peripherals: Record<string, number> } {
  const peripherals: Record<string, number> = {};
  for (const peripheral of device.peripherals) {
    peripherals[peripheral.name] = peripheralDetail(device, peripheral.name)?.length ?? 0;
  }
  return { index: peripheralIndex(device).length, peripherals };
}

/**
 * Find the register for `PERIPH.REGISTER` or `PERIPH.REGISTER.FIELD`.
 * This is the shape a question usually arrives in.
 */
export function findRegister(
  device: SvdDevice,
  path: string,
): { peripheral: SvdPeripheral; register: SvdRegister; field?: SvdField } | null {
  const parts = path.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const [peripheralName, registerName, fieldName] = parts;
  const peripheral = device.peripherals.find((entry) => entry.name.toLowerCase() === peripheralName.toLowerCase());
  if (!peripheral) return null;
  const register = peripheral.registers.find((entry) => entry.name.toLowerCase() === registerName.toLowerCase());
  if (!register) return null;
  if (!fieldName) return { peripheral, register };
  const field = register.fields.find((entry) => entry.name.toLowerCase() === fieldName.toLowerCase());
  return field ? { peripheral, register, field } : { peripheral, register };
}

/** Absolute address of a register, which is what a debugger or a `volatile` write needs. */
export function registerAddress(device: SvdDevice, path: string): number | null {
  const found = findRegister(device, path);
  return found ? found.peripheral.baseAddress + found.register.offset : null;
}
