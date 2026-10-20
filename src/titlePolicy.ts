/**
 * How a conversation gets its title.
 *
 * The title was always written by the model, on every new session, whether or
 * not the user wanted it. A title is six words about a conversation the user
 * just started; the first message already says what it is about, so a rule can
 * answer most of the time without a request at all.
 */

/** Whether to title conversations at all. */
export function autoTitleAllowed(prefs: { suggestions?: boolean } | undefined): boolean {
  return prefs?.suggestions !== false;
}

/**
 * A title from the message itself, or "" when the message is too thin to name.
 *
 * The rule is intentionally crude: first line, stripped of code fences and
 * trailing punctuation, cut on a word boundary. A bad rule title is worse than
 * a model one, so anything that reads as a fragment is rejected.
 */
export function ruleFirstTitle(message: string): string {
  const firstLine = String(message ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```") && !line.startsWith(">")) ?? "";
  if (!firstLine) return "";
  // Strip markdown emphasis and inline code, which read as noise in a list.
  const plain = firstLine.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
  if (plain.length < 8) return "";
  const words = plain.split(" ");
  const short = words.slice(0, 8).join(" ");
  const title = (short.length > 60 ? `${short.slice(0, 57)}…` : short).replace(/[.,;:!?，。；：！？]+$/, "");
  return title.length >= 8 ? title : "";
}
