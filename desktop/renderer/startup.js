/**
 * Startup decisions for the renderer.
 *
 * Kept out of `app.js` so they can be tested: that file touches `document`
 * and `localStorage` at module load, so it cannot be imported in a plain Node
 * test. It is also loaded by Electron before any build step runs, so it stays
 * plain JavaScript.
 */

/**
 * Which session to reopen on launch, or "" for none.
 *
 * The host creates a fresh session on every start and announces it with a
 * `state` event before `ready`. Remembering that id made "reopen last session"
 * compare a value with itself and never fire, so the renderer now records ids
 * only from `session_loaded` / `session_saved`, and this decides from those.
 *
 * @param {{remembered: string | null, current: string | null, enabled: boolean}} input
 * @returns {string}
 */
export function shouldRestoreSession(input) {
  const { remembered, current, enabled } = input;
  if (!enabled || !remembered) return "";
  if (remembered === current) return "";
  return remembered;
}

/**
 * The path of a dropped or pasted file, or "" when it has none.
 *
 * Electron removed `File.path` in version 32; `webUtils.getPathForFile` is the
 * replacement, reached through the preload bridge. A path that cannot be read
 * is reported by the caller rather than dropped silently.
 *
 * @param {unknown} file
 * @param {(file: unknown) => unknown} readPath
 * @returns {string}
 */
export function droppedFilePath(file, readPath) {
  try {
    return String(readPath(file) ?? "");
  } catch {
    return "";
  }
}
