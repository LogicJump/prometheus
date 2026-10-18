/**
 * Edit matching: find the span an edit refers to, with a ladder of tolerances.
 *
 * The model sees files through line-numbered reads and often reproduces text
 * with slightly different whitespace or indentation. Requiring a byte-exact
 * match turns every such guess into a failed call and a re-read. The ladder
 * keeps exact matches authoritative and only relaxes when there is exactly one
 * plausible candidate:
 *
 *   exact       byte-for-byte substring (today's behaviour)
 *   whitespace  per-line trailing whitespace and CRLF differences ignored
 *   indent      leading indentation ignored, replacement re-indented
 *   anchor      first and last line match uniquely, the span between is replaced
 *
 * Uniqueness is enforced at every rung. Ambiguity is an error that names the
 * candidate lines so the model can add context instead of guessing.
 */

export type MatchRung = "exact" | "whitespace" | "indent" | "anchor";

export interface Match {
  start: number;
  end: number;
  rung: MatchRung;
  /** The literal text that will be replaced (used for indentation reapplication). */
  matchedText: string;
}

export interface MatchFailure {
  reason: "empty" | "not-found" | "ambiguous";
  message: string;
  candidates: number[];
}

export type MatchResult = { ok: true; match: Match } | { ok: false; failure: MatchFailure };

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") line++;
  }
  return line;
}

function allIndexes(text: string, needle: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    hits.push(index);
    from = index + Math.max(1, needle.length);
  }
  return hits;
}

/** Trailing-whitespace- and CRLF-insensitive comparison of a haystack slice. */
function normalizeInline(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+(?=\n)/g, "");
}

function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.split("\n");
}

/** Exact match, used when the text appears verbatim. */
function exactMatch(text: string, needle: string, allowMultiple = false): MatchResult {
  const hits = allIndexes(text, needle);
  if (hits.length === 1 || (allowMultiple && hits.length > 1)) {
    return { ok: true, match: { start: hits[0], end: hits[0] + needle.length, rung: "exact", matchedText: needle } };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous",
        message: `found ${hits.length} exact matches`,
        candidates: hits.slice(0, 6).map((offset) => lineOf(text, offset)),
      },
    };
  }
  return { ok: false, failure: { reason: "not-found", message: "no exact match", candidates: [] } };
}

/**
 * Compare line arrays where each line is compared through `key`, and return
 * every start index of a full match.
 */
function lineMatchIndexes(fileLines: string[], needleLines: string[], key: (line: string) => string): number[] {
  if (needleLines.length === 0 || needleLines.length > fileLines.length) return [];
  const target = needleLines.map(key);
  const hits: number[] = [];
  for (let start = 0; start + target.length <= fileLines.length; start++) {
    let same = true;
    for (let offset = 0; offset < target.length; offset++) {
      if (key(fileLines[start + offset]) !== target[offset]) {
        same = false;
        break;
      }
    }
    if (same) hits.push(start);
  }
  return hits;
}

/**
 * Offsets of a line range in the original text, excluding the final newline so
 * a replacement never swallows the line break that follows it.
 */
function spanOfLines(text: string, startLine: number, endLineExclusive: number): { start: number; end: number } {
  const starts = lineStarts(text);
  const start = starts[startLine] ?? text.length;
  const lastStart = starts[endLineExclusive - 1] ?? text.length;
  const newline = text.indexOf("\n", lastStart);
  const end = newline === -1 ? text.length : newline;
  return { start, end };
}

export function findMatch(text: string, needle: string, allowMultiple = false): MatchResult {
  if (!needle) return { ok: false, failure: { reason: "empty", message: "search text is empty", candidates: [] } };

  const exact = exactMatch(text, needle, allowMultiple);
  if (exact.ok || exact.failure.reason === "ambiguous") return exact;

  // whitespace: trailing spaces/tabs per line and CRLF are ignored
  const fileLines = toLines(text);
  const needleLines = toLines(needle);
  // A needle ending in a newline means "this line, line break included".
  if (needleLines.length > 1 && needleLines[needleLines.length - 1] === "") needleLines.pop();
  const fileWhitespace = fileLines.map((line) => line.replace(/[ \t]+$/, ""));
  const needleWhitespace = needleLines.map((line) => line.replace(/[ \t]+$/, ""));
  const whitespaceHits = lineMatchIndexes(fileWhitespace, needleWhitespace, (line) => line);
  if (whitespaceHits.length === 1 || (allowMultiple && whitespaceHits.length > 1)) {
    const span = spanOfLines(text, whitespaceHits[0], whitespaceHits[0] + needleLines.length);
    return {
      ok: true,
      match: { ...span, rung: "whitespace", matchedText: text.slice(span.start, span.end) },
    };
  }
  if (whitespaceHits.length > 1) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous",
        message: `found ${whitespaceHits.length} matches ignoring trailing whitespace`,
        candidates: whitespaceHits.slice(0, 6).map((line) => line + 1),
      },
    };
  }

  // indent: leading indentation is ignored entirely
  const indentHits = lineMatchIndexes(fileLines, needleLines, (line) => line.trimStart());
  if (indentHits.length === 1 || (allowMultiple && indentHits.length > 1)) {
    const span = spanOfLines(text, indentHits[0], indentHits[0] + needleLines.length);
    return { ok: true, match: { ...span, rung: "indent", matchedText: text.slice(span.start, span.end) } };
  }
  if (indentHits.length > 1) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous",
        message: `found ${indentHits.length} matches ignoring indentation`,
        candidates: indentHits.slice(0, 6).map((line) => line + 1),
      },
    };
  }

  // anchor: only the first and last non-empty lines are compared
  const firstLine = needleLines.find((line) => line.trim() !== "");
  const lastLine = [...needleLines].reverse().find((line) => line.trim() !== "");
  if (firstLine && lastLine && needleLines.length > 2) {
    const firstHits = lineMatchIndexes(fileLines, [firstLine], (line) => line.trimStart()).length;
    const lastHits = lineMatchIndexes(fileLines, [lastLine], (line) => line.trimStart()).length;
    if (firstHits === 1 && lastHits === 1) {
      const startLine = lineMatchIndexes(fileLines, [firstLine], (line) => line.trimStart())[0];
      const lastIndex = lineMatchIndexes(fileLines, [lastLine], (line) => line.trimStart())[0];
      if (lastIndex >= startLine) {
        const span = spanOfLines(text, startLine, lastIndex + 1);
        return { ok: true, match: { ...span, rung: "anchor", matchedText: text.slice(span.start, span.end) } };
      }
    }
  }

  const near = closestLines(fileLines, needleLines[0] ?? "");
  return {
    ok: false,
    failure: {
      reason: "not-found",
      message: "the search text was not found (exact, whitespace-insensitive, and indentation-insensitive)",
      candidates: near,
    },
  };
}

/** Line numbers whose trimmed content is most similar to the needle's first line. */
function closestLines(fileLines: string[], needleLine: string): number[] {
  const target = needleLine.trim().toLowerCase();
  if (!target) return [];
  const scored = fileLines
    .map((line, index) => ({ index, score: similarity(line.trim().toLowerCase(), target) }))
    .filter((entry) => entry.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.index + 1);
  return scored;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let common = 0;
  for (let index = 0; index < shorter.length; index++) {
    if (shorter[index] === longer[index]) common++;
  }
  return common / longer.length;
}

/**
 * Re-indent a replacement to the indentation of the block it replaces. Only
 * used for the `indent` rung, where the model could not know the exact prefix.
 */
export function reindent(matchedText: string, oldText: string, newText: string): string {
  const oldIndent = /^[ \t]*/.exec(oldText.split("\n")[0] ?? "")?.[0] ?? "";
  const targetIndent = /^[ \t]*/.exec(matchedText.split("\n")[0] ?? "")?.[0] ?? "";
  if (targetIndent === oldIndent) return newText;
  return newText
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      // Shift each line by the same delta, so relative indentation survives.
      if (oldIndent && line.startsWith(oldIndent)) return `${targetIndent}${line.slice(oldIndent.length)}`;
      return `${targetIndent}${line}`;
    })
    .join("\n");
}

/** Split a SEARCH/REPLACE patch into blocks. */
export function parsePatch(patch: string): { search: string; replace: string }[] {
  const blocks: { search: string; replace: string }[] = [];
  const pattern = /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;
  for (const match of patch.matchAll(pattern)) {
    blocks.push({ search: match[1], replace: match[2] });
  }
  return blocks;
}

export { normalizeInline };
