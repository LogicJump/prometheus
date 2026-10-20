/**
 * Whether a tool call needs the board identified first.
 *
 * Identification used to happen only when the Board pane scanned. A user who
 * went straight to the agent and said "flash it" got `config.board.target` —
 * a name saved from the last board — and the firmware went to whatever that
 * name described. `config.board` is a preference; the chip is evidence.
 *
 * The gate is deliberately cheap and keeps no timers: it answers "does this
 * call need a scan", and the host memoises the scan it runs.
 */

export interface IdentificationInput {
  /** The saved selection. A target here is what a tool would otherwise use. */
  board?: { target?: string } | null;
  /** The identity the last scan read, if any. */
  identity?: unknown;
  /** Probes the last scan saw. 0 means identification cannot succeed. */
  probes?: number;
}

export class IdentificationNeed {
  private identified = false;
  private lastSelection = "";

  /**
   * Whether to scan before answering the call.
   *
   * True only when a stored target would be used and nothing has identified
   * the board since the user last changed the selection.
   */
  shouldIdentify(input: IdentificationInput): boolean {
    if (input.identity) return false;
    if (!input.board?.target) return false;
    if (input.probes === 0) return false;
    if (this.identified) return false;
    return true;
  }

  /** A scan ran. It counts even when it found nothing: retrying on every call
   *  would turn a board that is not plugged in into a stalled turn. */
  markIdentified(): void {
    this.identified = true;
  }

  /** The user changed the selection, so the old answer may no longer apply. */
  noteSelection(board: { target?: string } | null | undefined): void {
    const next = board?.target ?? "";
    if (next !== this.lastSelection) {
      this.lastSelection = next;
      this.identified = false;
    }
  }
}
