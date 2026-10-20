/**
 * The serial pane's port dropdown, decided away from the DOM.
 *
 * The dropdown used to read `state.boardState.ports`, which only exists after
 * the Board pane has scanned. Opening the Serial tab first left it empty, and
 * Start returned without a word.
 */

/**
 * The port rows to draw.
 *
 * @param {{ports: {path: string, board?: string, description?: string, vid?: string}[], current: string, saved: string}} input
 * @returns {{path: string, label: string, selected: boolean}[]}
 */
export function serialPortChoices(input) {
  const ports = Array.isArray(input.ports) ? input.ports : [];
  // An open monitor knows its own port; otherwise the saved selection wins,
  // and a lone port is the only one it can be.
  const wanted = input.current || input.saved || (ports.length === 1 ? ports[0].path : "");
  return ports.map((port) => ({
    path: port.path,
    label: port.description || port.board ? `${port.path} — ${port.description || port.board}` : port.path,
    selected: port.path === wanted,
  }));
}

/**
 * Why Start would do nothing, or "" when it will open the port.
 *
 * @param {{open: boolean, port: string, ports: {path: string}[]}} input
 * @returns {"" | "noPort" | "choosePort"}
 */
export function startBlockedReason(input) {
  if (input.open) return "";
  if (input.port) return "";
  return (input.ports ?? []).length === 0 ? "noPort" : "choosePort";
}

/**
 * The bytes for one send.
 *
 * A bootloader prompt often wants no line ending at all, and the pane is used
 * against bootloaders as much as against a console; the ending is the user's
 * choice rather than something the app decides.
 *
 * @param {string} text
 * @param {"lf"|"crlf"|"none"} ending
 * @returns {string}
 */
export function encodeSend(text, ending) {
  if (ending === "none") return text;
  return text + (ending === "crlf" ? "\r\n" : "\n");
}

/**
 * The status line after a write.
 *
 * @param {{port: string, bytes: number}} result
 * @param {string} label  the translated "sent" word
 */
export function writtenNotice(result, label) {
  return `${label} ${result.port} · ${result.bytes} B`;
}

/**
 * Selected console lines as a message the user can send to the agent.
 *
 * The port travels with the text because a log without its source is a puzzle;
 * the fenced block keeps the lines verbatim instead of letting markdown reflow
 * them.
 *
 * @param {{port: string | null, lines: {text: string}[]}} input
 * @returns {string}
 */
export function selectedLinesAsQuote(input) {
  const lines = input.lines ?? [];
  if (lines.length === 0) return "";
  const port = input.port ? ` (${input.port})` : "";
  return `Serial output${port}:\n\n\`\`\`\n${lines.map((line) => line.text).join("\n")}\n\`\`\`\n`;
}
