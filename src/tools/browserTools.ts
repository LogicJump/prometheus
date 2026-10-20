/**
 * Browser tools the agent can call.
 *
 * The app already has a Browser pane — an Electron `WebContentsView` the user
 * navigates. The agent could not see it, so "open this page and tell me what
 * the docs say" was impossible without copying text by hand.
 *
 * The split of responsibility matters: the tools are *declared* here in the
 * agent process and *executed* in the Electron main process, where the view
 * lives. A tool call travels host → main → renderer-pane → main → host. That is
 * one extra hop and it keeps the agent process free of Electron, which is what
 * lets the same code run in a terminal.
 *
 * When nothing is listening (a CLI run, a test), every tool reports that the
 * pane is unavailable instead of hanging.
 */

import type { Tool } from "../types.ts";

/** Set by the host when the desktop window answers browser requests. */
export interface BrowserBridge {
  request(request: { kind: "open" | "read" | "screenshot"; url?: string; selector?: string }): Promise<{
    ok: boolean;
    error?: string;
    url?: string;
    title?: string;
    text?: string;
    dataUrl?: string;
  }>;
}

let bridge: BrowserBridge | null = null;

/** The host installs the bridge at startup; tests install a fake. */
export function setBrowserBridge(next: BrowserBridge | null): void {
  bridge = next;
}

const UNAVAILABLE = "The browser pane is not available in this run (it exists only in the desktop window).";

export const browserOpenTool: Tool = {
  name: "browser_open",
  description:
    "Open a URL in the app's Browser pane and return the page title. Use it when the user asked you to look at a page; the pane stays open for them to see.",
  // Not readonly, although it writes no file. Opening a page is a network
  // request the user did not make, and the page's own scripts then run with
  // the pane's privileges — the same class of action as running `curl`. Under
  // a read-only label it ran in plan mode, and in ask mode it ran without a
  // prompt, which is how a "don't touch anything" session could still fetch a
  // URL. `browser_read` and `browser_screenshot` inspect a page that is
  // already open and stay readonly.
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.url ?? ""),
  async execute(input) {
    if (!bridge) return { isError: true, content: UNAVAILABLE };
    const url = String(input.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return { isError: true, content: "Only absolute http(s) URLs can be opened in the browser pane." };
    }
    const result = await bridge.request({ kind: "open", url });
    if (!result.ok) return { isError: true, content: `could not open ${url}: ${result.error ?? "unknown error"}` };
    return { content: `Opened ${result.url ?? url}${result.title ? ` — ${result.title}` : ""}`, display: result.title ?? url };
  },
};

export const browserReadTool: Tool = {
  name: "browser_read",
  description:
    "Read the visible text of the page currently in the Browser pane, or of one element selected by a CSS selector. Returns the page URL and title with the text.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "Optional CSS selector; omitted means the whole page" },
      max_chars: { type: "integer", description: "Cap on returned characters (default 20000)" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.selector ?? "whole page"),
  async execute(input) {
    if (!bridge) return { isError: true, content: UNAVAILABLE };
    const result = await bridge.request({ kind: "read", ...(input.selector ? { selector: String(input.selector) } : {}) });
    if (!result.ok) return { isError: true, content: result.error ?? "could not read the page" };
    const limit = Number(input.max_chars) > 0 ? Number(input.max_chars) : 20_000;
    const text = String(result.text ?? "");
    const clipped = text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
    return {
      content: `URL: ${result.url ?? "(unknown)"}\nTitle: ${result.title ?? "(none)"}\n\n${clipped || "(the page has no visible text)"}`,
      display: result.title ?? result.url ?? "page",
    };
  },
};

export const browserScreenshotTool: Tool = {
  name: "browser_screenshot",
  description:
    "Capture the Browser pane as a PNG and return the file path. Use it when the user asks what a page looks like; describe the layout from the image you receive next turn.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  summarize: () => "screenshot the browser pane",
  async execute() {
    if (!bridge) return { isError: true, content: UNAVAILABLE };
    const result = await bridge.request({ kind: "screenshot" });
    if (!result.ok) return { isError: true, content: result.error ?? "could not capture the page" };
    return {
      content: `Screenshot of ${result.url ?? "the page"} saved to ${result.text ?? "(no path)"}.`,
      display: result.url ?? "screenshot",
    };
  },
};

export const browserTools: Tool[] = [browserOpenTool, browserReadTool, browserScreenshotTool];
