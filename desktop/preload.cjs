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
  revealFile: (path) => ipcRenderer.invoke("reveal-file", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  platform: process.platform,
});
