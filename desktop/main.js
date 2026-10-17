/** Electron main process: one window, one agent host child process per window. */

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, "host.js");
// Packaged: argv = [exe, ...userArgs]. Dev: argv = [electron, appPath, ...userArgs].
const userArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const cliArgs = userArgs.filter((arg, index) => {
  if (arg.startsWith("-")) return false;
  const previous = userArgs[index - 1];
  // Chromium flags that take a separate value: the value is not a workspace.
  return !(previous === "--user-data-dir" || previous === "--remote-debugging-port" || previous === "--inspect");
});

if (process.env.PROMETHEUS_DEBUG_ARGV) {
  try {
    appendFileSync(
      process.env.PROMETHEUS_DEBUG_ARGV,
      `${new Date().toISOString()} packaged=${app.isPackaged} argv=${JSON.stringify(process.argv)}\n`,
    );
  } catch {
    /* ignore */
  }
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Electron spins up extra processes (GPU, crashpad, utility) with the same
// command line. Only the browser process may treat a folder argument as the
// workspace; otherwise a helper would chdir and fight the main process for it.
const isBrowserProcess = !process.type || process.type === "browser";

/** Launch a packaged app with a workspace: `Prometheus.exe <folder>`. */
if (app.isPackaged && isBrowserProcess && !process.env.ELECTRON_RUN_AS_NODE) {
  const candidate = cliArgs.find(isDirectory);
  if (candidate) {
    try {
      process.chdir(candidate);
    } catch {
      /* not a directory */
    }
  }
}
/** Packaged apps start from a temp extraction dir; remember the user's last workspace instead. */
function initialWorkspace(explicitWorkspace) {
  // A folder argument always wins over the remembered workspace.
  if (explicitWorkspace) return explicitWorkspace;
  try {
    const saved = JSON.parse(readFileSync(join(app.getPath("userData"), "workspace.json"), "utf8"));
    if (saved.cwd && existsSync(saved.cwd) && saved.explicit) return saved.cwd;
  } catch {
    /* first launch */
  }
  return app.isPackaged ? homedir() : process.cwd();
}

function rememberWorkspace(cwd, explicit = false) {
  try {
    const file = join(app.getPath("userData"), "workspace.json");
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* none yet */
    }
    const next = explicit || !previous.explicit ? { cwd, explicit: explicit || previous.explicit === true } : previous;
    writeFileSync(file, JSON.stringify(next), "utf8");
  } catch {
    /* persistence is best-effort */
  }
}

function startWindow() {
  // Read the candidate here, in the browser process, not at module load.
  const explicitWorkspace = app.isPackaged ? cliArgs.find(isDirectory) : undefined;
  const startCwd = initialWorkspace(explicitWorkspace);
  if (process.env.PROMETHEUS_DEBUG_ARGV) {
    try {
      appendFileSync(process.env.PROMETHEUS_DEBUG_ARGV, `startCwd=${startCwd} cliArgs=${JSON.stringify(cliArgs)}\n`);
    } catch {
      /* ignore */
    }
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0e0e10",
    title: "Prometheus",
    icon: join(here, "..", "build", "icon.png"),
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
        if (process.env.PROMETHEUS_DEMO_JS) {
          try {
            const result = await win.webContents.executeJavaScript(process.env.PROMETHEUS_DEMO_JS);
            console.log(`[demo] js result: ${JSON.stringify(result)}`);
          } catch (err) {
            console.log(`[demo] js failed: ${err.message}`);
          }
          await new Promise((resolve) => setTimeout(resolve, Number(process.env.PROMETHEUS_DEMO_WAIT ?? 4000)));
        } else if (prompt) {
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
    cwd: startCwd,
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
    sendToHost({ cmd: "init", cwd: startCwd, mode: process.env.PROMETHEUS_PERMISSION_MODE });
    if (explicitWorkspace) rememberWorkspace(explicitWorkspace, true);
  });
  win.on("closed", () => {
    host.kill();
  });

  return { win, sendToHost };
}

app.whenReady().then(() => {
  const debugLog = (line) => {
    if (!process.env.PROMETHEUS_DEBUG_ARGV) return;
    try {
      appendFileSync(process.env.PROMETHEUS_DEBUG_ARGV, `${line}\n`);
    } catch {
      /* ignore */
    }
  };
  debugLog(`ready cwd=${process.cwd()} cliArgs=${JSON.stringify(cliArgs)}`);
  const { sendToHost } = startWindow();
  debugLog("window created");

  ipcMain.on("host-send", (_event, payload) => {
    if (payload?.cmd === "setCwd" && payload.cwd) rememberWorkspace(payload.cwd, true);
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

  ipcMain.handle("notify", async (event, { title, body }) => {
    if (!Notification.isSupported()) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    // Clicking the notification should bring the window forward, not open a
    // second one.
    const notification = new Notification({ title: String(title), body: String(body) });
    notification.on("click", () => {
      const target = window && !window.isDestroyed() ? window : BrowserWindow.getAllWindows()[0];
      if (target && !target.isDestroyed()) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
    });
    notification.show();
    return true;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) startWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
