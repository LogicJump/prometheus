/**
 * Sub-agent cards, keyed by the id the agent gives each sub-task.
 *
 * The renderer kept one `currentSubagent` slot: a second sub-agent overwrote
 * the first, whichever finished first cleared the slot, and the other end
 * event found nothing to update. Parallel and background sub-tasks made that
 * the common case rather than the corner.
 */

export class SubagentCards {
  constructor() {
    /** @type {Map<string, {id: string, prompt: string, status: string, count: number, node: unknown}>} */
    this.cards = new Map();
    this.order = [];
  }

  /**
   * @param {string | undefined} id
   * @param {string} prompt
   * @param {unknown} [node]  the DOM element, when there is one
   */
  start(id, prompt, node = null) {
    // A sub-task started without an id still needs a card; a synthetic key
    // keeps the newest-running fallback from mutating an unrelated card.
    const key = id || `anonymous-${this.order.length}`;
    const card = { id: key, prompt, status: "running", count: 0, node };
    this.cards.set(key, card);
    this.order.push(key);
    return card;
  }

  get(id) {
    return this.cards.get(id);
  }

  /** The most recently started card that is still running. */
  newestRunning() {
    for (let index = this.order.length - 1; index >= 0; index--) {
      const card = this.cards.get(this.order[index]);
      if (card?.status === "running") return card;
    }
    return undefined;
  }

  /** The card an event belongs to: by id, else the newest still running. */
  resolve(id) {
    return (id && this.cards.get(id)) || this.newestRunning();
  }

  activity(id, kind, text) {
    const card = this.resolve(id);
    if (!card) return undefined;
    card.count += 1;
    return card;
  }

  end(id, ok) {
    const card = this.resolve(id);
    if (!card) return undefined;
    card.status = ok ? "done" : "failed";
    return card;
  }

  clear() {
    this.cards.clear();
    this.order = [];
  }
}
