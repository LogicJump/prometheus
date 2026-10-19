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
import { killTree } from "../src/winsandbox.ts";

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
 * Encode one command for the PowerShell pipe.
 *
 * Writing a multi-line block (`if (...) {` … `}`) straight into `-Command -`
 * leaves the shell in continuation state, so the sentinel line that follows
 * becomes part of the block: the command and the sentinel are both swallowed
 * and the pane stays busy forever. An unterminated quote or here-string is
 * worse — nothing recovers without a restart.
 *
 * Sending the command as base64 and dot-sourcing a script block avoids the
 * parser entirely. It also fixes non-ASCII input: PowerShell 5.1 decodes stdin
 * bytes in the console code page, but base64 is ASCII.
 */
export function encodeCommand(command, kind) {
  if (kind !== "powershell") return command;
  const payload = Buffer.from(command, "utf8").toString("base64");
  return `. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))))`;
}

/** Commands that need a real terminal; refusing them beats a ten-minute hang. */
const INTERACTIVE = /^\s*(vim|vi|nvim|nano|emacs|less|more|top|htop|btop|watch|man|ssh|telnet|ftp|mysql|psql|sqlite3|irb|python|python3|node|pwsh|powershell|cmd|read-host|pause)\b/i;

/**
 * True only for a program that will take over the input stream.
 *
 * `python script.py` runs and exits; plain `python` opens a REPL. The
 * difference is whether an argument follows, so a command is judged
 * interactive only when the matched program is the whole command (modulo
 * flags that the program itself understands).
 */
export function looksInteractive(command) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const match = INTERACTIVE.exec(trimmed);
  if (!match) return false;
  const program = match[1].toLowerCase();
  const rest = trimmed.slice(match[0].length).trim();
  if (!rest) return true;
  // A pipeline or redirect turns the program into one step the pane can run.
  if (/[|<>]/.test(rest)) return false;
  // `cmd /c …` and `powershell -Command …` are one-shot forms that exit.
  if (/^(cmd|powershell|pwsh)$/i.test(program) && /(^|\s)(\/c|-c|-command)\b/i.test(rest)) return false;
  // `python script.py` runs and exits; only `-i` keeps it open. The same is
  // true of the other interpreters.
  if (/^(python3?|node|irb|pwsh|powershell|sh|bash|cmd)$/.test(program)) {
    return /(^|\s)-[a-z]*i\b/i.test(rest);
  }
  // Editors, pagers, interactive clients and REPLs that take arguments still
  // hand the terminal over: `vim file`, `ssh host`, `mysql -u user`.
  return true;
}

/**
 * CSI/OSC escape sequences.
 *
 * Without a PTY, programs that print colour or clear the screen send the
 * escapes literally; the pane renders raw text, so `\x1b[31m` showed up as
 * `[31m` and a clear-screen left a `2J` behind. Colour cannot be restored, but
 * the residue can at least be removed.
 */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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
  feed(rawText) {
    const text = rawText.replace(ANSI, "");
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
    this.watchdog = null;
    this.killedForInterrupt = false;
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
    // Closing the pane while a write is in flight surfaces as an EPIPE on
    // stdin. Without a listener that is an uncaught exception that takes the
    // whole host down over a closed terminal.
    this.child.stdin.on("error", () => {
      this.exited = true;
    });
    // PowerShell writes its error stream in the console code page, not UTF-8,
    // so a Chinese error message decodes as mojibake. Setting both encodings at
    // start is what makes the error text readable.
    if (spec.kind === "powershell") {
      this.write("[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8\r\n");
    }
    this.child.on("exit", (code) => {
      this.exited = true;
      this.clearWatchdog();
      // Interrupt already printed its own line; repeating "shell exited" would
      // read like a second failure.
      if (!this.killedForInterrupt) this.emitVisible(`\r\n[shell exited${code ? ` with code ${code}` : ""}]\r\n`);
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
      this.clearWatchdog();
      this.onState({ cwd: this.cwd, busy: false });
    }
  }

  /** Write to the shell, tolerating a pipe that closed underneath us. */
  write(text) {
    if (this.exited || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(text, (err) => {
        // A write after the shell exited raises EPIPE asynchronously; the exit
        // handler already reports the state, so swallowing it here is right.
        void err;
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Run one command line. */
  run(command) {
    if (this.exited) return false;
    if (this.busy) return false;
    if (looksInteractive(command)) {
      this.emitVisible(
        "\r\n[this pane is a command runner, not a terminal; interactive programs need a real terminal]\r\n",
      );
      return false;
    }
    this.busy = true;
    this.emitVisible(`\r\n${this.cwd}> ${command}\r\n`);
    this.onState({ cwd: this.cwd, busy: true });
    if (!this.write(`${encodeCommand(command, this.kind)}\r\n${markerCommand(this.kind)}\r\n`)) {
      this.busy = false;
      this.onState({ cwd: this.cwd, busy: false, exited: this.exited });
      return false;
    }
    // A command that never returns would leave the pane busy forever with no
    // way to type. The pane's own interrupt kills the shell; this is the
    // backstop for when the user does not notice.
    this.armWatchdog();
    return true;
  }

  /**
   * Stop the current command.
   *
   * `SIGINT` is not delivered on Windows — a child of a `spawn`ed shell has no
   * console to receive it — so the honest move is to kill the shell. The pane
   * then shows the exit and the next command restarts it, rather than pretending
   * the command stopped and leaving its output to interleave with the next one.
   */
  interrupt() {
    if (this.exited) return;
    this.clearWatchdog();
    this.killedForInterrupt = true;
    // `child.kill()` is TerminateProcess on Windows and reaches only the shell;
    // a build the shell started keeps running and holds the port or the file
    // lock. `killTree` walks the tree with `taskkill /T`.
    killTree(this.child.pid);
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.busy = false;
    // Mark it exited immediately: `kill()` is asynchronous, and the pane's next
    // keystroke can arrive before the exit event. `ensureTerminal` rebuilds on
    // `exited`, so the next command gets a fresh shell instead of being refused.
    this.exited = true;
    this.emitVisible("\r\n[interrupted; the shell was restarted]\r\n");
    this.onState({ cwd: this.cwd, busy: false, exited: true });
  }

  armWatchdog() {
    this.clearWatchdog();
    // Ten minutes: long enough for a real build, short enough that a pane stuck
    // on a prompt nobody can reach recovers within a coffee break.
    this.watchdog = setTimeout(() => {
      if (!this.busy || this.exited) return;
      this.emitVisible("\r\n[command still running after 10 minutes; interrupt it or the shell will be restarted]\r\n");
    }, 600_000);
    // The timer must not hold the host process open when the pane is idle.
    this.watchdog.unref?.();
  }

  clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  dispose() {
    this.clearWatchdog();
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}
