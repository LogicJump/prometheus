/** Electron main process: one window, one agent host child process per window. */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "host.js");
const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("-psn"));

function startWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e0e10",
    title: "Prometheus",
    titleBarStyle: "hidden",
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#0e0e10", symbolColor: "#9d9da6", height: 48 }
        : undefined,
    trafficLightPosition: { x: 16, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(join(here, "renderer", "index.html"));

  if (process.env.PROMETHEUS_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => {
      const prompt = process.env.PROMETHEUS_DEMO_PROMPT;
      setTimeout(async () => {
        if (prompt) {
          win.webContents.executeJavaScript(
            `document.querySelector('[data-mode="auto"]').click();` +
              `document.getElementById("input").value = ${JSON.stringify(prompt)}; document.getElementById("send-button").click();`,
          );
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        }
        const image = await win.webContents.capturePage();
        const { writeFileSync } = await import("node:fs");
        writeFileSync(process.env.PROMETHEUS_SCREENSHOT, image.toPNG());
        if (process.env.PROMETHEUS_SCREENSHOT_KEEP) return;
        app.quit();
      }, prompt ? 1500 : 3500);
    });
  }

  const host = spawn(process.execPath, [HOST], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const sendToRenderer = (message) => {
    if (!win.isDestroyed()) win.webContents.send("host-event", message);
  };

  createInterface({ input: host.stdout }).on("line", (line) => {
    try {
      sendToRenderer(JSON.parse(line));
    } catch {
      sendToRenderer({ type: "notice", level: "warn", text: line });
    }
  });
  createInterface({ input: host.stderr }).on("line", (line) => {
    sendToRenderer({ type: "notice", level: "error", text: line });
  });
  host.on("exit", (code) => {
    sendToRenderer({ type: "host_exit", code });
  });

  const sendToHost = (payload) => {
    if (host.stdin.writable) host.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  win.webContents.on("did-finish-load", () => {
    sendToHost({ cmd: "init", cwd: process.cwd(), mode: process.env.PROMETHEUS_PERMISSION_MODE });
  });

  win.on("closed", () => {
    host.kill();
  });

  return { win, sendToHost };
}

app.whenReady().then(() => {
  const { sendToHost } = startWindow();

  ipcMain.on("host-send", (_event, payload) => {
    sendToHost(payload);
  });

  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("reveal-file", async (_event, path) => {
    if (existsSync(path)) shell.showItemInFolder(path);
  });

  ipcMain.handle("open-external", async (_event, url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) startWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Allow launching the app with `electron . <cwd>`
if (cliArgs.length > 0) {
  const candidate = cliArgs[0];
  if (existsSync(candidate)) {
    process.chdir(candidate);
  }
}
