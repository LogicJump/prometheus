/**
 * Desktop system integration: tray, launch at login, keep-awake, quick entry.
 *
 * All of it is optional and reversible. State lives in userData/system.json so
 * a crash or an upgrade does not silently turn the tray back on, and every
 * call is defensive: a platform that refuses one of these (a Linux session
 * without a tray, a macOS build without a bundle id) must not take the window
 * down with it.
 */

import { app, BrowserWindow, globalShortcut, Menu, nativeImage, powerSaveBlocker, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  launchAtLogin: false,
  tray: false,
  keepAwake: false,
  quickEntry: "",
};

export class SystemIntegration {
  constructor({ iconPath, onShow }) {
    this.iconPath = iconPath;
    this.onShow = onShow;
    this.settings = { ...DEFAULTS };
    this.tray = null;
    this.awakeBlocker = null;
    this.file = join(app.getPath("userData"), "system.json");
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      this.settings = { ...DEFAULTS, ...saved };
    } catch {
      this.settings = { ...DEFAULTS };
    }
  }

  save() {
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.settings, null, 2), "utf8");
    } catch {
      /* best effort */
    }
  }

  /** Apply everything that survives a restart. Called once the app is ready. */
  start() {
    this.applyLaunchAtLogin(this.settings.launchAtLogin);
    this.applyTray(this.settings.tray);
    this.applyQuickEntry(this.settings.quickEntry);
  }

  stop() {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* nothing registered */
    }
    this.tray?.destroy();
    this.tray = null;
    if (this.awakeBlocker !== null && powerSaveBlocker.isStarted(this.awakeBlocker)) {
      powerSaveBlocker.stop(this.awakeBlocker);
    }
    this.awakeBlocker = null;
  }

  state() {
    return {
      ...this.settings,
      // Keep-awake is session-scoped in the UI; report what is actually held.
      awakeActive: this.awakeBlocker !== null && powerSaveBlocker.isStarted(this.awakeBlocker),
      platform: process.platform,
      // A packaged macOS app cannot register a login item without a bundle.
      launchSupported: process.platform !== "linux" || app.isPackaged,
    };
  }

  set(key, value) {
    switch (key) {
      case "launchAtLogin":
        this.settings.launchAtLogin = Boolean(value);
        this.applyLaunchAtLogin(this.settings.launchAtLogin);
        break;
      case "tray":
        this.settings.tray = Boolean(value);
        this.applyTray(this.settings.tray);
        break;
      case "keepAwake":
        this.settings.keepAwake = Boolean(value);
        this.applyKeepAwake(this.settings.keepAwake);
        break;
      case "quickEntry":
        this.settings.quickEntry = String(value ?? "").slice(0, 64);
        this.applyQuickEntry(this.settings.quickEntry);
        break;
      default:
        return this.state();
    }
    this.save();
    return this.state();
  }

  applyLaunchAtLogin(enabled) {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    } catch {
      /* unsupported on this platform */
    }
  }

  applyTray(enabled) {
    if (!enabled) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (this.tray) return;
    let image = null;
    try {
      image = nativeImage.createFromPath(this.iconPath);
      if (image.isEmpty()) image = null;
    } catch {
      image = null;
    }
    try {
      this.tray = new Tray(image ?? nativeImage.createEmpty());
      this.tray.setToolTip("Prometheus");
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Prometheus", click: () => this.onShow?.() },
          { type: "separator" },
          { label: "Quit", click: () => app.quit() },
        ]),
      );
      this.tray.on("click", () => this.onShow?.());
    } catch {
      this.tray = null;
    }
  }

  applyKeepAwake(enabled) {
    if (enabled) {
      if (this.awakeBlocker === null || !powerSaveBlocker.isStarted(this.awakeBlocker)) {
        try {
          this.awakeBlocker = powerSaveBlocker.start("prevent-app-suspension");
        } catch {
          this.awakeBlocker = null;
        }
      }
      return;
    }
    if (this.awakeBlocker !== null) {
      try {
        if (powerSaveBlocker.isStarted(this.awakeBlocker)) powerSaveBlocker.stop(this.awakeBlocker);
      } catch {
        /* already stopped */
      }
      this.awakeBlocker = null;
    }
  }

  applyQuickEntry(accelerator) {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* nothing registered */
    }
    if (!accelerator) return;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        if (!win) return;
        if (win.isVisible() && win.isFocused()) win.hide();
        else {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      });
      if (!ok) this.settings.quickEntry = "";
    } catch {
      // An invalid or already-taken accelerator is reported, not fatal.
      this.settings.quickEntry = "";
    }
  }
}
