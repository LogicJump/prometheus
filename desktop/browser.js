/**
 * The in-app browser pane.
 *
 * Electron cannot render arbitrary sites inside the renderer, so the page is a
 * WebContentsView layered over the window by the main process. The renderer
 * reports the pane's rectangle in window coordinates and the main process keeps
 * the view there; all navigation goes through IPC.
 *
 * The view runs sandboxed without node integration and shares no session with
 * the app, so a page the agent opens cannot reach the agent's files.
 */

import { WebContentsView } from "electron";

const views = new WeakMap();

function sessionFor(win) {
  return win?.webContents?.session ?? null;
}

export function openBrowser(win, url = "about:blank") {
  if (!win || win.isDestroyed()) return null;
  let view = views.get(win);
  if (!view) {
    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        // Keep the browser pane out of the app's own storage and cookies.
        partition: "prometheus-browser",
      },
    });
    view.setBackgroundColor("#ffffff");
    win.contentView.addChildView(view);
    views.set(win, view);
    view.webContents.on("did-navigate", () => emitState(win, view));
    view.webContents.on("did-navigate-in-page", () => emitState(win, view));
    view.webContents.on("page-title-updated", () => emitState(win, view));
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      // New windows open in the same pane instead of spawning OS windows.
      if (/^https?:/.test(target)) void view.webContents.loadURL(target);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, target) => {
      if (!/^(https?|about|data):/.test(target)) event.preventDefault();
    });
    void sessionFor(win);
  }
  if (url && url !== "about:blank") void view.webContents.loadURL(normalizeUrl(url));
  emitState(win, view);
  return view;
}

function normalizeUrl(input) {
  const text = String(input).trim();
  if (!text) return "about:blank";
  if (/^[a-z]+:\/\//i.test(text) || text === "about:blank") return text;
  if (/^localhost(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  return `https://${text}`;
}

function emitState(win, view) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("browser-state", {
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    canGoBack: view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward(),
    loading: view.webContents.isLoading(),
  });
}

export function setBrowserBounds(win, bounds) {
  const view = views.get(win);
  if (!view) return;
  const { x, y, width, height } = bounds ?? {};
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return;
  view.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  });
}

export function browserNavigate(win, action, arg) {
  const view = views.get(win);
  if (!view) return null;
  const wc = view.webContents;
  if (action === "back") wc.navigationHistory.goBack();
  else if (action === "forward") wc.navigationHistory.goForward();
  else if (action === "reload") wc.reload();
  else if (action === "stop") wc.stop();
  else if (action === "load") void wc.loadURL(normalizeUrl(arg));
  else if (action === "devtools") wc.openDevTools({ mode: "detach" });
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

export function browserSnapshot(win, options = {}) {
  const view = views.get(win);
  if (!view) return null;
  const wc = view.webContents;
  const selector = options.selector ? JSON.stringify(String(options.selector)) : "null";
  const limit = Number(options.maxChars) > 0 ? Math.min(200_000, Number(options.maxChars)) : 12_000;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    // The renderer inserts this into the composer, so the result is a plain
    // string the agent can read. A selector narrows it to one element, which is
    // what makes "read the code block on this page" cheaper than the whole DOM.
    text: wc
      .executeJavaScript(
        `(() => {
           const selector = ${selector};
           const root = selector ? document.querySelector(selector) : document.body;
           if (!root) return "";
           const text = root.innerText || "";
           return text.replace(/\\n{3,}/g, "\\n\\n").slice(0, ${limit});
         })()`,
      )
      .catch(() => ""),
  };
}

/** A PNG of the visible viewport, as a data URL. */
export async function browserScreenshot(win) {
  const view = views.get(win);
  if (!view) return { ok: false, error: "the browser pane is not open" };
  try {
    const image = await view.webContents.capturePage();
    return { ok: true, url: view.webContents.getURL(), dataUrl: image.toDataURL() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function closeBrowser(win) {
  const view = views.get(win);
  if (!view) return;
  views.delete(win);
  try {
    win.contentView.removeChildView(view);
    view.webContents.close();
  } catch {
    /* already gone */
  }
}
