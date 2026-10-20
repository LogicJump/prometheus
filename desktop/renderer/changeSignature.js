/**
 * The diff pane's "has this changed" key.
 *
 * It is read twice a second while a turn runs, and rebuilding the pane throws
 * away the reader's scroll position. The old key used `file.diff` — a field
 * `ChangeSummary` has never had — so every entry contributed a constant and a
 * reworded hunk with unchanged line counts rendered nothing. Line counts plus
 * the hunks themselves keep the key cheap and complete.
 */

/**
 * @param {{files: {path: string, additions: number, deletions: number, hunks?: {header?: string, lines?: string[]}[]}[], selected: string, scope: string}} input
 * @returns {string}
 */
export function changeSignature(input) {
  const files = input.files ?? [];
  const parts = files.map((file) => {
    const hunks = (file.hunks ?? []).map((hunk) => `${hunk.header ?? ""}\u0001${(hunk.lines ?? []).join("\u0002")}`).join("\u0003");
    return `${file.path}:${file.additions}:${file.deletions}:${hunks.length}:${hunks}`;
  });
  return `${parts.join("|")}#${input.selected ?? ""}#${input.scope ?? ""}`;
}
