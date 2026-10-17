/**
 * Line diff for the changes panel.
 *
 * A plain LCS over lines, grouped into unified-diff hunks with context. File
 * contents are small enough (the read tool caps at 2 MB) that O(n*m) memory is
 * acceptable; we bail out to a whole-file replace above a guard threshold.
 */

export type DiffKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** Set when the file is too large or binary; hunks are empty. */
  skipped?: string;
}

const MAX_LINES = 4000;
const CONTEXT = 3;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  // A trailing newline terminates the last line rather than starting an empty one.
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

interface Op {
  kind: DiffKind;
  text: string;
}

/** LCS table diff. Falls back to delete-all/add-all when inputs are huge. */
function diffSequences(a: string[], b: string[]): Op[] {
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  // Trim common prefix and suffix so the table stays small in the common case.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  // Uint32 LCS lengths; rows*cols must stay bounded.
  if (rows * cols > 16_000_000) {
    return [
      ...midA.map((text) => ({ kind: "del" as const, text })),
      ...midB.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const table = new Uint32Array(rows * cols);
  const at = (i: number, j: number) => i * cols + j;
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = cols - 2; j >= 0; j--) {
      table[at(i, j)] =
        midA[i] === midB[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ kind: "context", text: a[k] });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      ops.push({ kind: "context", text: midA[i] });
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ kind: "del", text: midA[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: midB[j] });
      j++;
    }
  }
  while (i < midA.length) ops.push({ kind: "del", text: midA[i++] });
  while (j < midB.length) ops.push({ kind: "add", text: midB[j++] });
  for (let k = endA; k < n; k++) ops.push({ kind: "context", text: a[k] });
  return ops;
}

/** Build unified hunks with line numbers for a before/after pair. */
export function diffFile(path: string, before: string | null, after: string | null): FileDiff {
  const status = before === null ? "added" : after === null ? "deleted" : "modified";
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const ops = diffSequences(a, b);

  const numbered: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "context") {
      numbered.push({ kind: "context", text: op.text, oldNo: oldNo++, newNo: newNo++ });
    } else if (op.kind === "del") {
      numbered.push({ kind: "del", text: op.text, oldNo: oldNo++, newNo: null });
      deletions++;
    } else {
      numbered.push({ kind: "add", text: op.text, oldNo: null, newNo: newNo++ });
      additions++;
    }
  }

  return { path, status, additions, deletions, hunks: groupHunks(numbered) };
}

function groupHunks(lines: DiffLine[]): Hunk[] {
  const changed = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return [];

  // Merge change ranges separated by <= 2*CONTEXT context lines.
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last && index - last[1] <= CONTEXT * 2 + 1) last[1] = index;
    else ranges.push([index, index]);
  }

  const hunks: Hunk[] = [];
  for (const [from, to] of ranges) {
    const start = Math.max(0, from - CONTEXT);
    const end = Math.min(lines.length - 1, to + CONTEXT);
    const slice = lines.slice(start, end + 1);
    const firstOld = slice.find((line) => line.oldNo !== null)?.oldNo ?? 0;
    const firstNew = slice.find((line) => line.newNo !== null)?.newNo ?? 0;
    hunks.push({
      oldStart: firstOld,
      oldCount: slice.filter((line) => line.oldNo !== null).length,
      newStart: firstNew,
      newCount: slice.filter((line) => line.newNo !== null).length,
      lines: slice,
    });
  }
  return hunks;
}

export interface ChangeSummary {
  path: string;
  status: FileDiff["status"];
  additions: number;
  deletions: number;
  hunks: Hunk[];
  skipped?: string;
}

/** Build the changes payload the renderer consumes. */
export function buildChange(path: string, before: string | null, after: string | null): ChangeSummary {
  if (looksBinary(before) || looksBinary(after)) {
    return { path, status: before === null ? "added" : after === null ? "deleted" : "modified", additions: 0, deletions: 0, hunks: [], skipped: "binary file" };
  }
  const diff = diffFile(path, before, after);
  if (diff.hunks.length === 0 && diff.status === "modified") {
    return { path, status: "modified", additions: 0, deletions: 0, hunks: [], skipped: "no textual changes" };
  }
  return { path, status: diff.status, additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks };
}

function looksBinary(text: string | null): boolean {
  if (text === null) return false;
  const sample = text.slice(0, 8000);
  return sample.includes("\u0000");
}
