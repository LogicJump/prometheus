/**
 * What the Board pane shows, decided away from the DOM.
 *
 * The pane had accumulated decisions made inline — which target name applies,
 * whether the chip or the user supplied it, whether the attached probes exist
 * at all — and the inline versions drifted: a stored name was labelled "read
 * from the part", and the probe list quietly disappeared. Keeping the
 * decisions here makes them testable and keeps `renderBoard` a renderer.
 */

/**
 * How the shown target name came to be.
 *
 * - `chip`: the part answered and exactly one name fits it.
 * - `picked`: the part answered with a family and the name is one candidate
 *   the user chose. The family is measured; the part number is not.
 * - `manual`: nothing was read; the name is a saved preference.
 * - `unlisted`: the part answered and no installed tool names it.
 * - `none`: nothing to flash.
 */
export function resolveSource(board, selection) {
  const declared = board?.targetSource ?? (board?.effective?.target || selection?.target ? "manual" : "none");
  if (declared === "chip") {
    const options = Array.isArray(board.targetOptions) ? board.targetOptions : [];
    const chosen = String(board?.effective?.target ?? selection?.target ?? "");
    // More than one name fits the measured family. The host picks the stored
    // one when it is among them and the first otherwise; either way the part
    // number was selected, not read.
    if (options.length > 1 && chosen) return "picked";
    return "chip";
  }
  return declared;
}

/** One line under the target: what the name rests on. */
export function sourceLabel(view, t) {
  switch (view.source) {
    case "chip":
      return t.boardReadFromChip;
    case "picked":
      return t.boardTargetPicked ?? t.boardReadFromChip;
    case "manual":
      return t.boardTargetManual;
    case "unlisted":
      return t.boardTargetUnlisted ? t.boardTargetUnlisted(view.identity?.family ?? "") : "";
    default:
      return "";
  }
}

/** The verdict under the target row. */
export function targetStatusNote(status, t) {
  if (!status || status.kind === "unloaded") return t.boardTargetsUnloaded;
  if (status.kind === "exact") return t.boardTargetExact;
  if (status.kind === "candidates") return t.boardTargetCandidates;
  return t.boardTargetAbsent;
}

function matchesQuery(entry, needle) {
  if (!needle) return true;
  return [entry.name, entry.vendor, entry.part].some((value) => String(value ?? "").toLowerCase().includes(needle));
}

/**
 * Everything the pane needs to draw, from the three messages it receives.
 *
 * @param {object} input
 * @param {object|null} input.board      the `board_state` payload
 * @param {object} input.selection       the saved selection
 * @param {object|null} input.status     `targetStatus` from the host
 * @param {object|null} [input.targets]  the `board_targets` payload
 * @param {string} [input.query]         the table's filter box
 * @param {object} input.t              the dictionary
 */
export function buildTargetView(input) {
  const board = input.board ?? {};
  const selection = input.selection ?? {};
  const t = input.t ?? {};
  const scanned = Boolean(board.scannedAt);
  const source = resolveSource(board, selection);

  const probes = (Array.isArray(board.probes) ? board.probes : []).map((probe) => {
    const serial = String(probe.serial ?? "");
    return {
      kind: String(probe.kind ?? ""),
      name: String(probe.name ?? probe.kind ?? ""),
      serial,
      active: Boolean(serial) && serial === String(selection.probe ?? ""),
      selectable: Boolean(serial),
      target: String(probe.target ?? ""),
      targetText: probe.target ? `${t.boardReported ?? ""} ${probe.target}`.trim() : (t.boardNoReportedTarget ?? ""),
    };
  });

  const table = input.targets ?? null;
  const needle = String(input.query ?? "").trim().toLowerCase();
  const rows = table && Array.isArray(table.targets) ? table.targets.filter((entry) => matchesQuery(entry, needle)) : [];

  return {
    scanned,
    source,
    needsChoice: source === "picked",
    identity: board.identity ?? null,
    probes,
    targets: rows,
    targetsTotal: table ? Number(table.total ?? rows.length) : 0,
    targetsLoaded: Boolean(table),
    targetNote: targetStatusNote(input.status, t),
    alternatives: Array.isArray(board.targetOptions) ? board.targetOptions : [],
  };
}
