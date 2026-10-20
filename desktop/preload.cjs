/** Preload bridge: the only surface the renderer can use to reach the main process. */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prometheus", {
  send: (payload) => ipcRenderer.send("host-send", payload),
  onEvent: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("host-event", listener);
    return () => ipcRenderer.removeListener("host-event", listener);
  },
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  pickFile: (options) => ipcRenderer.invoke("pick-file", options),
  readImage: (path) => ipcRenderer.invoke("read-image", path),
  newWindow: () => ipcRenderer.send("new-window"),
  splitWindow: (options) => ipcRenderer.send("split-window", options),
  windowControl: (action) => ipcRenderer.send("window-control", action),
  windowState: () => ipcRenderer.invoke("window-state"),
  onWindowState: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  restartHost: () => ipcRenderer.send("host-restart"),
  saveFile: (suggestedName, content, filters) => ipcRenderer.invoke("save-file", { suggestedName, content, filters }),
  browserOpen: (url) => ipcRenderer.invoke("browser-open", url),
  browserBounds: (bounds) => ipcRenderer.invoke("browser-bounds", bounds),
  browserNavigate: (action, arg) => ipcRenderer.invoke("browser-navigate", action, arg),
  browserSnapshot: (options) => ipcRenderer.invoke("browser-snapshot", options),
  browserScreenshot: () => ipcRenderer.invoke("browser-screenshot"),
  browserClose: () => ipcRenderer.invoke("browser-close"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  systemState: () => ipcRenderer.invoke("system-state"),
  systemSet: (key, value) => ipcRenderer.invoke("system-set", key, value),
  onBrowserState: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("browser-state", listener);
    return () => ipcRenderer.removeListener("browser-state", listener);
  },
  revealFile: (path) => ipcRenderer.invoke("reveal-file", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),
  platform: process.platform,
});
