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
  newWindow: () => ipcRenderer.send("new-window"),
  saveFile: (suggestedName, content) => ipcRenderer.invoke("save-file", { suggestedName, content }),
  browserOpen: (url) => ipcRenderer.invoke("browser-open", url),
  browserBounds: (bounds) => ipcRenderer.invoke("browser-bounds", bounds),
  browserNavigate: (action, arg) => ipcRenderer.invoke("browser-navigate", action, arg),
  browserSnapshot: () => ipcRenderer.invoke("browser-snapshot"),
  browserClose: () => ipcRenderer.invoke("browser-close"),
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
