/** Markdown-to-terminal rendering, in the restrained style of modern coding agents. */

const colorOn = process.stdout.isTTY && !process.env.NO_COLOR;

export const ansi = {
  bold: (s: string) => (colorOn ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (colorOn ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s: string) => (colorOn ? `\x1b[31m${s}\x1b[39m` : s),
  green: (s: string) => (colorOn ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s: string) => (colorOn ? `\x1b[33m${s}\x1b[39m` : s),
  magenta: (s: string) => (colorOn ? `\x1b[35m${s}\x1b[39m` : s),
  cyan: (s: string) => (colorOn ? `\x1b[36m${s}\x1b[39m` : s),
  gray: (s: string) => (colorOn ? `\x1b[90m${s}\x1b[39m` : s),
};

/** Width of a string when rendered in a terminal, counting wide CJK characters as 2. */
export function displayWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x1100 && code <= 0x115f ? 2 : code >= 0x2e80 ? 2 : 1;
  }
  return width;
}

/** True while a code fence or an inline span has been opened but not closed. */
export function hasOpenMarkdown(text: string): boolean {
  let fences = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fences++;
      inFence = !inFence;
    }
  }
  if (inFence) return true;
  void fences;
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");
  const lastLine = withoutFences.slice(withoutFences.lastIndexOf("\n") + 1);
  return (lastLine.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** Render inline markdown (code spans, bold) and light block structure. */
export function renderMarkdown(text: string): string {
  if (!colorOn) return stripDecorations(text);
  const lines = text.split("\n");
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      const lang = line.trim().replace(/^```/, "");
      out.push(ansi.gray(`  ${inFence ? `┄${lang ? ` ${lang}` : ""}` : "┄"}`));
      continue;
    }
    if (inFence) {
      out.push(ansi.gray(`  ${line}`));
      continue;
    }
    out.push(
      line
        .replace(/`([^`]+)`/g, (_m, code: string) => ansi.cyan(code))
        .replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => ansi.bold(bold))
        .replace(/^(\s*)[-*]\s+/, (_m, pad: string) => `${pad}${ansi.gray("·")} `)
        .replace(/^(\s*)#{1,6}\s+(.*)$/, (_m, pad: string, title: string) => `${pad}${ansi.bold(title)}`)
        .replace(/^(\s*>\s?)(.*)$/, (_m, pad: string, body: string) => `${pad}${ansi.gray(body)}`),
    );
  }
  return out.join("\n");
}

function stripDecorations(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      /^\s*```/.test(line)
        ? ansi.gray(`  ${line.trim()}`)
        : line.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1"),
    )
    .join("\n");
}
