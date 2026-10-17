/**
 * Embedded terminal: one persistent shell per workspace, driven over stdio.
 *
 * The shell is not a PTY, so the UI cannot read a prompt out of the output.
 * Instead each submitted line is followed by a sentinel command that prints a
 * marker plus the working directory. Output before the marker is the result of
 * that command; the marker tells the pane the shell is idle again and where it
 * now is (so `cd` in the terminal is reflected back to the UI).
 *
 * PowerShell is preferred on Windows because cmd.exe loses UTF-8 once its code
 * page changes; the shell is configurable through PROMETHEUS_SHELL.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MARKER = "__PROMETHEUS_DONE__";
const MAX_SCROLLBACK = 400_000;

function shellSpec() {
  if (process.env.PROMETHEUS_SHELL) {
    return { kind: "powershell", command: process.env.PROMETHEUS_SHELL, args: [] };
  }
  if (process.platform === "win32") {
    return {
      kind: "powershell",
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"],
    };
  }
  const command = process.env.SHELL || "/bin/sh";
  return { kind: "posix", command, args: ["-i"] };
}

function markerCommand(kind) {
  return kind === "powershell"
    ? `Write-Output ("${MARKER}" + (Get-Location).Path)`
    : `printf '\\n${MARKER}%s\\n' "$PWD"`;
}

/**
 * Separates command output from completion markers in a byte stream.
 *
 * `feed` returns the text that should be shown, holding back any partial
 * marker line (the marker can straddle two stdout chunks) until it is known
 * whether the line is a marker.
 */
export class MarkerParser {
  constructor() {
    this.pending = "";
  }

  /**
   * @param {string} text
   * @returns {{text: string, completed: string[]}}
   */
  feed(text) {
    this.pending += text;
    let visible = "";
    const completed = [];
    for (;;) {
      const index = this.pending.indexOf(MARKER);
      if (index < 0) {
        // Hold back a tail that could still grow into a marker.
        let keep = 0;
        const max = Math.min(MARKER.length - 1, this.pending.length);
        for (let length = max; length > 0; length--) {
          if (MARKER.startsWith(this.pending.slice(-length))) {
            keep = length;
            break;
          }
        }
        visible += keep > 0 ? this.pending.slice(0, -keep) : this.pending;
        this.pending = keep > 0 ? this.pending.slice(-keep) : "";
        return { text: visible, completed };
      }
      const end = this.pending.indexOf("\n", index);
      if (end < 0) {
        visible += this.pending.slice(0, index);
        this.pending = this.pending.slice(index);
        return { text: visible, completed };
      }
      visible += this.pending.slice(0, index);
      completed.push(this.pending.slice(index + MARKER.length, end).replace(/\r$/, "").trim());
      this.pending = this.pending.slice(end + 1);
    }
  }
}

export class TerminalSession {
  /**
   * @param {object} options
   * @param {string} options.cwd
   * @param {(chunk: string) => void} options.onOutput
   * @param {(state: {cwd: string, busy: boolean, exited?: boolean}) => void} options.onState
   */
  constructor({ cwd, onOutput, onState }) {
    this.cwd = cwd;
    this.onOutput = onOutput;
    this.onState = onState;
    this.busy = false;
    this.scrollback = "";
    this.parser = new MarkerParser();
    this.decoder = new StringDecoder("utf8");
    const spec = shellSpec();
    this.kind = spec.kind;
    this.exited = false;
    this.child = spawn(spec.command, spec.args, {
      cwd,
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => this.consume(chunk));
    this.child.on("exit", (code) => {
      this.exited = true;
      this.emitVisible(`\r\n[shell exited${code ? ` with code ${code}` : ""}]\r\n`);
      this.onState({ cwd: this.cwd, busy: false, exited: true });
    });
  }

  emitVisible(text) {
    if (!text) return;
    this.scrollback += text;
    if (this.scrollback.length > MAX_SCROLLBACK) {
      this.scrollback = this.scrollback.slice(-MAX_SCROLLBACK);
    }
    this.onOutput(text);
  }

  /** Emit everything before any completed marker line, then consume the marker. */
  consume(chunk) {
    const { text, completed } = this.parser.feed(this.decoder.write(chunk));
    this.emitVisible(text);
    for (const reported of completed) {
      if (reported) this.cwd = reported;
      this.busy = false;
      this.onState({ cwd: this.cwd, busy: false });
    }
  }

  /** Run one command line. */
  run(command) {
    if (this.exited) return false;
    this.busy = true;
    this.emitVisible(`\r\n${this.cwd}> ${command}\r\n`);
    this.onState({ cwd: this.cwd, busy: true });
    this.child.stdin.write(`${command}\r\n${markerCommand(this.kind)}\r\n`);
    return true;
  }

  /** Stop the current command by killing the shell; the next run starts fresh. */
  interrupt() {
    try {
      this.child.kill("SIGINT");
    } catch {
      /* ignore */
    }
    this.busy = false;
    this.onState({ cwd: this.cwd, busy: false });
  }

  dispose() {
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}
