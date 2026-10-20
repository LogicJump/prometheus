/**
 * Where a split window may sit.
 *
 * A split window was placed at a fixed offset from its parent and then sized
 * 60% of the parent, with no check against the screen. On a second display
 * with a smaller work area — or on the edge of the primary one — the result
 * could run past the right edge or under the taskbar, and the window's own
 * controls were off-screen.
 */

/**
 * Clamp `bounds` into `workArea`.
 *
 * Only the position moves when the window is larger than the area; shrinking
 * belongs to the caller, which knows the minimum size.
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @param {{x: number, y: number, width: number, height: number}} workArea
 */
export function splitClamp(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height));
  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) return bounds;
  return { x, y, width, height };
}
