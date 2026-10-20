/**
 * The preference values the settings page edits.
 *
 * `fillSettings` copied the appearance values out of the host's answer but
 * never these five, so the switches rendered from whatever the page happened to
 * have in `state` — which nothing ever assigned. Every one of them read as its
 * default on every open, and a user who turned one off saw it on again.
 */

/** The keys, in the order the defaults table lists them. */
export const PREFERENCE_FIELDS = ["restartSession", "suggestions", "updateCheck", "isolateByDefault", "uiScale"];

/**
 * @param {Record<string, unknown>} settings  the host's `settings` payload
 * @returns {{restartSession: boolean, suggestions: boolean, updateCheck: boolean, isolateByDefault: boolean, uiScale: number}}
 */
export function filledPreferences(settings) {
  const value = settings ?? {};
  const scale = Number(value.uiScale);
  return {
    // These three are on unless the host says otherwise; that is how the host
    // reports them (`!== false`) and how they behave before anything is set.
    restartSession: value.restartSession !== false,
    suggestions: value.suggestions !== false,
    updateCheck: value.updateCheck !== false,
    isolateByDefault: Boolean(value.isolateByDefault),
    uiScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}
