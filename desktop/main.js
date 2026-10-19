/** Electron main process: one window, one agent host child process per window. */

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { browserNavigate, browserSnapshot, browserScreenshot, closeBrowser, openBrowser, setBrowserBounds } from "./browser.js";
import { SystemIntegration } from "./system.js";

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

/**
 * The app's own version. app.getVersion() reports Electron's version when the
 * packaged bundle carries no app package.json, so read ours first and keep the
 * Electron answer only as a fallback.
 */
function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    if (pkg?.name === "prometheus" && pkg.version) return String(pkg.version);
  } catch {
    /* fall through */
  }
  return app.getVersion();
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

/** Numeric compare of dotted versions: 1.10.0 > 1.9.2. */
function compareVersions(left, right) {
  const a = String(left).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
    // The renderer draws its own minimize / maximize / close buttons on
    // Windows and Linux so they match the top bar and follow the app theme.
    // macOS keeps its traffic lights.
    titleBarStyle: "hidden",
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

  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send("window-state", { maximized: win.isMaximized() });
  };
  win.on("maximize", sendWindowState);
  win.on("unmaximize", sendWindowState);

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
        writeFileSync(process.env.PROMETHEUS_SCREENSHOT, image.toPNG());
        if (process.env.PROMETHEUS_SCREENSHOT_KEEP) return;
        app.quit();
      }, prompt || process.env.PROMETHEUS_DEMO_JS ? 1500 : 3500);
    });
  }

  const sendToRenderer = (message) => {
    if (!win.isDestroyed()) win.webContents.send("host-event", message);
  };

  let host = null;
  let hostCwd = startCwd;

  const sendToHost = (payload) => {
    if (!host) return;
    if (host.stdin.writable) host.stdin.write(`${JSON.stringify(payload)}
`);
  };

  /**
   * (Re)start the agent process. Called at launch and again from the renderer's
   * retry button after a crash, so a host failure does not require closing the
   * window or losing the workspace.
   */
  function startHost(cwd) {
    hostCwd = cwd || hostCwd;
    host = spawn(process.execPath, [HOST], {
      cwd: hostCwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
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
    sendToHost({ cmd: "init", cwd: hostCwd, mode: process.env.PROMETHEUS_PERMISSION_MODE });
  }

  /**
   * Stop the agent process without orphaning its grandchildren.
   *
   * `kill()` on Windows is TerminateProcess: the host never runs its stdin-end
   * handler, so the PowerShell reading a serial port survives and keeps COM7
   * open. The host therefore has a `shutdown` command that disposes its ports
   * and exits; this asks for it, closes stdin as a second signal, and only
   * falls back to a hard kill if the process is still there after 500 ms.
   */
  function stopHost() {
    const target = host;
    host = null;
    if (!target) return;
    try {
      if (target.stdin.writable) target.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      target.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        target.kill();
      } catch {
        /* already gone */
      }
    }, 500);
    target.once("exit", () => clearTimeout(timer));
  }

  // IPC is app-wide; route each window's commands to its own host. Without
  // this a second window would drive the first window's agent.
  ipcMain.on("host-send", (event, payload) => {
    if (!win.isDestroyed() && event.sender === win.webContents) sendToHost(payload);
  });

  ipcMain.on("host-restart", (event) => {
    if (win.isDestroyed() || event.sender !== win.webContents) return;
    stopHost();
    startHost(hostCwd);
  });

  win.webContents.on("did-finish-load", () => {
    if (explicitWorkspace) rememberWorkspace(explicitWorkspace, true);
  });
  win.on("closed", () => {
    stopHost();
  });
  startHost(startCwd);

  return { win, sendToHost };
}

/**
 * One app instance per user.
 *
 * Two windows are supported — each runs its own agent host — but two *launches*
 * are not: the second would load a second copy of the tray icon, the global
 * shortcut, the update check and the workspace-last-used file, and the two
 * copies overwrite each other's `workspace.json`. A second launch brings the
 * first instance's window forward instead.
 *
 * The single-window/single-session rule lives in the session lock
 * (`src/sessionLock.ts`): a window cannot open a session another window has,
 * so even within one instance two windows never write one transcript.
 */
if (!app.requestSingleInstanceLock()) {
  // This launch loses the race: the instance that owns the lock already has
  // the window. Quit without ever reaching whenReady.
  app.exit(0);
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  // The second launch holds no lock and has already quit; whenReady still
  // resolves, so do nothing here rather than creating a window it cannot own.
  if (!app.hasSingleInstanceLock()) return;
  const debugLog = (line) => {
    if (!process.env.PROMETHEUS_DEBUG_ARGV) return;
    try {
      appendFileSync(process.env.PROMETHEUS_DEBUG_ARGV, `${line}\n`);
    } catch {
      /* ignore */
    }
  };
  debugLog(`ready cwd=${process.cwd()} cliArgs=${JSON.stringify(cliArgs)}`);

  // Tray, launch-at-login, keep-awake, and the quick-entry shortcut are the
  // user's choices; the window is not.
  const system = new SystemIntegration({
    iconPath: join(here, "..", "build", "icon.png"),
    onShow: () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  });
  system.start();

  startWindow();
  debugLog("window created");

  // Every window answers "setCwd" for itself; the workspace to remember is
  // whichever window sent it.
  ipcMain.on("host-send", (event, payload) => {
    if (payload?.cmd === "setCwd" && payload.cwd) rememberWorkspace(payload.cwd, true);
    void event;
  });

  // A second window runs its own agent host, so two sessions can work in
  // parallel without sharing transcript state.
  ipcMain.on("new-window", () => {
    startWindow();
  });

  // Custom caption buttons: the renderer owns their look, the main process
  // owns the actual window state.
  ipcMain.on("window-control", (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close();
  });

  ipcMain.handle("window-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { maximized: Boolean(win?.isMaximized()) };
  });

  ipcMain.handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  // 离线安装：内网机器连不上工具链的下载站，用户手上只有一个压缩包。
  ipcMain.handle("pick-file", async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: options.filters ?? [],
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("reveal-file", async (_event, path) => {
    if (existsSync(path)) shell.showItemInFolder(path);
  });

  ipcMain.handle("save-file", async (_event, { suggestedName, content, filters }) => {
    // The transcript exports Markdown; the serial monitor exports a .log. The
    // extension of the suggested name is the honest default, and a caller that
    // knows better passes its own filters.
    const chosen = Array.isArray(filters) && filters.length > 0
      ? filters
      : [{ name: "Markdown", extensions: ["md"] }];
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName || "export.md",
      filters: chosen,
    });
    if (result.canceled || !result.filePath) return { saved: false };
    writeFileSync(result.filePath, String(content ?? ""), "utf8");
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle("open-external", async (_event, url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle("browser-open", async (event, url) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const view = openBrowser(win, url);
    return Boolean(view);
  });

  ipcMain.handle("browser-bounds", async (event, bounds) => {
    setBrowserBounds(BrowserWindow.fromWebContents(event.sender), bounds);
    return true;
  });

  ipcMain.handle("browser-navigate", async (event, action, arg) => {
    return browserNavigate(BrowserWindow.fromWebContents(event.sender), action, arg);
  });

  ipcMain.handle("browser-snapshot", async (event, options = {}) => {
    const snapshot = browserSnapshot(BrowserWindow.fromWebContents(event.sender), options);
    if (!snapshot) return null;
    return { url: snapshot.url, title: snapshot.title, text: await snapshot.text };
  });

  /**
   * Screenshot for the agent's `browser_screenshot` tool.
   *
   * Saved under the config home rather than returned inline: a base64 image in
   * a tool result would be megabytes of context. The path is what the model can
   * hand to an image-reading turn.
   */
  ipcMain.handle("browser-screenshot", async (event) => {
    const result = await browserScreenshot(BrowserWindow.fromWebContents(event.sender));
    if (!result.ok) return result;
    const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    const dir = join(app.getPath("userData"), "browser-shots");
    await mk(dir, { recursive: true });
    const file = join(dir, `shot-${Date.now()}.png`);
    const base64 = String(result.dataUrl).replace(/^data:image\/png;base64,/, "");
    await wf(file, Buffer.from(base64, "base64"));
    return { ok: true, url: result.url, path: file };
  });

  ipcMain.handle("browser-close", async (event) => {
    closeBrowser(BrowserWindow.fromWebContents(event.sender));
    return true;
  });


  ipcMain.handle("app-version", async () => appVersion());

  ipcMain.handle("system-state", async () => system.state());
  ipcMain.handle("system-set", async (_event, key, value) => system.set(key, value));

  /**
   * Update check against a JSON feed at PROMETHEUS_UPDATE_URL, shaped like a
   * GitHub latest-release response: { tag_name, html_url, body }. Updates are
   * installed by the user; nothing downloads or runs unattended.
   */
  ipcMain.handle("check-update", async () => {
    const feed = process.env.PROMETHEUS_UPDATE_URL;
    if (!feed) return { status: "unconfigured" };
    try {
      const response = await fetch(feed, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { status: "error", message: `HTTP ${response.status}` };
      const latest = await response.json();
      const tag = String(latest.tag_name ?? latest.version ?? "").replace(/^v/, "");
      const current = appVersion();
      return {
        status: compareVersions(tag, current) > 0 ? "available" : "current",
        latest: tag,
        current,
        url: typeof latest.html_url === "string" ? latest.html_url : null,
      };
    } catch (err) {
      return { status: "error", message: err.message };
    }
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

app.on("will-quit", () => {
  // Unregister the global shortcut before exit; Electron does not do this on
  // every platform, and a stale shortcut survives into the next launch.
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* nothing registered */
  }
});
