/**
 * The sidebar's session list: which sessions a filter shows.
 *
 * The host owns this because the list is paged — filtering in the renderer
 * meant "only errors" hid failures beyond the first page, and search only saw
 * the rows that had been sent. Keeping the decision here also gives the three
 * places that push a fresh list (a save, a status change, archiving) one
 * function to call, so a push cannot quietly reset the filter the user chose.
 */

import { resolve } from "node:path";

/**
 * @typedef {object} SessionView
 * @property {string} status  "all", or one of the statuses `setSessionStatus` writes.
 * @property {string} cwd     An absolute workspace path, or "" for every workspace.
 */

/** @type {SessionView} */
export const EMPTY_SESSION_VIEW = { status: "all", cwd: "" };

/** Windows paths differ in case and separators; compare them one way. */
export function canonicalCwd(path) {
  try {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.replace(/[\\]+/g, "/").toLowerCase() : resolved;
  } catch {
    return path;
  }
}

/**
 * Merge a request into the current view.
 *
 * A push with no options keeps what the user selected; a request only changes
 * the fields it names. `includeArchived` is deliberately not part of the view:
 * it is a separate toggle every list is already filtered by.
 *
 * @param {SessionView} current
 * @param {{status?: unknown, cwd?: unknown}} [options]
 * @returns {SessionView}
 */
export function resolveSessionView(current, options = {}) {
  const status = options.status === undefined || options.status === null ? "" : String(options.status);
  const cwd = options.cwd === undefined || options.cwd === null ? "" : String(options.cwd);
  return {
    status: status || current.status || "all",
    cwd: cwd ? canonicalCwd(cwd) : current.cwd,
  };
}

/**
 * Sessions the view shows. A session with no stored status is "ready".
 *
 * @template {{status?: string, cwd?: string}} T
 * @param {readonly T[]} sessions
 * @param {SessionView} view
 * @returns {T[]}
 */
export function filterSessions(sessions, view) {
  return sessions.filter((session) => {
    if (view.status !== "all" && (session.status ?? "ready") !== view.status) return false;
    if (view.cwd && canonicalCwd(String(session.cwd ?? "")) !== view.cwd) return false;
    return true;
  });
}
