/** One-off: rasterize build/icon.svg to a 512px PNG for the app and installer. */

import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "icon.svg"), "utf8");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    backgroundColor: "#0e0e10",
    webPreferences: { offscreen: false },
  });
  const html = `<html style="overflow:hidden"><body style="margin:0;background:#0e0e10;overflow:hidden">${svg.replace(
    "<svg ",
    '<svg width="512" height="512" style="display:block" ',
  )}</body></html>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.webContents.once("did-finish-load", () => setTimeout(async () => {
    const image = await win.webContents.capturePage();
    writeFileSync(join(here, "icon.png"), image.toPNG());
    console.log("wrote icon.png");
    app.quit();
  }, 1500));
});
