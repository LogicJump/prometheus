#!/usr/bin/env node
// @ts-nocheck -- plain JavaScript entry point; the typed helpers live in src/.
/**
 * Run one command as a detached worker.
 *
 * Entry point for `prometheus work --worker-id … -- <command>`. The parent
 * returns as soon as this process has been spawned, so the user gets their
 * prompt back; this process keeps the command alive, streams its output into
 * the worker's log, and closes the record when the command exits.
 *
 * Detached deliberately: the worker must survive the terminal that started it
 * and the desktop host that might have started it. Its state lives on disk, so
 * `prometheus workers` and `prometheus attach` read it from any other process.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { appendWorkerLog, finishWorker } from "../src/workers.ts";

async function main() {
  const args = process.argv.slice(2);
  const idAt = args.indexOf("--worker-id");
  const separator = args.indexOf("--");
  if (idAt < 0 || !args[idAt + 1] || separator < 0) {
    process.stderr.write("usage: prometheus work --worker-id <id> -- <command>\n");
    process.exitCode = 2;
    return;
  }
  const workerId = args[idAt + 1];
  const command = args.slice(separator + 1).join(" ");
  if (!command.trim()) {
    finishWorker(workerId, "failed", "no command was given");
    process.exitCode = 2;
    return;
  }

  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const child = spawn(shell, shellArgs, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const started = Date.now();
  const stamp = () => new Date().toISOString().slice(11, 19);
  const emit = (stream, chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line) appendLog(workerId, `[${stamp()}] ${stream === "err" ? "! " : ""}${line}`);
    }
  };
  child.stdout.on("data", (chunk) => emit("out", chunk));
  child.stderr.on("data", (chunk) => emit("err", chunk));

  const cancelSignal = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", cancelSignal);
  process.on("SIGTERM", cancelSignal);

  child.on("error", (error) => {
    appendLog(workerId, `could not start the command: ${error.message}`);
    finishWorker(workerId, "failed", `could not start: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const summary =
      signal !== null
        ? `stopped by ${signal} after ${seconds}s`
        : code === 0
          ? `finished in ${seconds}s`
          : `exited ${code} after ${seconds}s`;
    appendLog(workerId, `— ${summary}`);
    finishWorker(workerId, code === 0 ? "done" : "failed", summary);
    process.exit(code ?? 1);
  });
}

function appendLog(workerId, line) {
  appendWorkerLog(workerId, line);
}

void main();
