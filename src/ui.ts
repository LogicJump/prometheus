/** Terminal renderer: colors, tool lines, spinner, and an inline confirmation prompt. */

import * as readline from "node:readline/promises";
import type { TodoItem, Ui } from "./types.ts";
import { ansi as style, displayWidth, hasOpenMarkdown, renderMarkdown } from "./render.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TerminalUi implements Ui {
  private spinnerTimer: NodeJS.Timeout | undefined;
  private spinnerFrame = 0;
  private spinnerText = "";
  private lastSpinnerLen = 0;
  private assistantActive = false;
  private thinkingActive = false;
  private rl: readline.Interface | undefined;
  /** True while the REPL's readline owns the prompt; confirmation asks must use it. */
  interactive = false;
  private readonly transcript: { role: "user" | "assistant"; text: string; at: number; cwd: string; model: string }[] = [];
  private modelName = "";
  private streamedText = "";
  /** True when streamed text ended mid-line, so the next readline prompt must start fresh. */
  private lineDirty = false;

  private readonly out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
  }

  attachReadline(rl: readline.Interface): void {
    this.rl = rl;
    this.interactive = true;
  }

  detachReadline(): void {
    this.rl = undefined;
    this.interactive = false;
  }

  /** Consume the "stream ended mid-line" flag so the caller can re-prompt cleanly. */
  takeLineDirty(): boolean {
    const dirty = this.lineDirty;
    this.lineDirty = false;
    return dirty;
  }

  setModelName(name: string): void {
    this.modelName = name;
  }

  /** Echo a submitted user message into the transcript. */
  echoUser(text: string): void {
    this.assistantEnd();
    this.thinkingEnd();
    this.spinnerStop();
    const firstLine = text.split("\n")[0];
    const more = text.includes("\n") ? style.dim(" …") : "";
    this.out.write(`\r\n${style.cyan("›")} ${style.bold(firstLine)}${more}\r\n\r\n`);
    this.appendTranscript("user", text);
  }

  private appendTranscript(role: "user" | "assistant", text: string): void {
    this.transcript.push({ role, text, at: Date.now(), cwd: process.cwd(), model: this.modelName });
  }

  /** Write a plain block that is already formatted. */
  private write(text: string): void {
    this.clearSpinnerLine();
    this.out.write(text.replace(/\n/g, "\r\n"));
  }

  private clearSpinnerLine(): void {
    if (this.lastSpinnerLen > 0) {
      this.out.write(`\r${" ".repeat(this.lastSpinnerLen)}\r`);
      this.lastSpinnerLen = 0;
    }
  }

  info(text: string): void {
    this.assistantEnd();
    this.thinkingEnd();
    this.clearSpinnerLine();
    this.out.write(`${text.replace(/\n/g, "\r\n")}\r\n`);
  }

  dim(text: string): void {
    this.info(style.dim(text));
  }

  warn(text: string): void {
    this.info(`${style.yellow("!")} ${text}`);
  }

  error(text: string): void {
    this.info(`${style.red("×")} ${style.red(text)}`);
  }

  assistantText(delta: string): void {
    if (this.thinkingActive) this.thinkingEnd();
    const isFirst = !this.assistantActive;
    if (isFirst) {
      this.clearSpinnerLine();
      this.assistantActive = true;
      this.streamedText = "";
      this.out.write("\r\n");
      // The readline prompt for the next line has not been drawn yet.
      this.lineDirty = false;
    }
    this.streamedText += delta;
    if (hasOpenMarkdown(this.streamedText)) {
      // Inside an unclosed code fence or inline span: repaint the last line so
      // the final styling is correct once the delimiter closes.
      const lines = this.streamedText.split("\n");
      const tail = renderMarkdown(lines[lines.length - 1]);
      const tailOnly = tail.includes("\n") ? tail.slice(tail.lastIndexOf("\n") + 1) : tail;
      this.out.write(`\r\x1b[2K${tailOnly}`);
      this.lineDirty = true;
      return;
    }
    const visible = renderMarkdown(delta).replace(/\n/g, "\r\n");
    this.out.write(visible);
    if (this.streamedText.endsWith("\n") || visible.includes("\r\n")) this.lineDirty = false;
    else this.lineDirty = true;
  }

  /** Finish the current streamed answer before printing a non-assistant block. */
  endStreamedText(): void {
    this.assistantEnd();
  }

  assistantEnd(): void {
    if (this.assistantActive) {
      if (this.streamedText.trim()) this.appendTranscript("assistant", this.streamedText);
      this.streamedText = "";
      this.out.write("\r\n");
      this.assistantActive = false;
      this.lineDirty = false;
    }
  }

  thinking(_delta: string): void {
    if (this.assistantActive) this.assistantEnd();
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      this.out.write(style.gray("\r\n· thinking\r\n"));
    }
  }

  thinkingEnd(): void {
    if (this.thinkingActive) {
      this.out.write("\r\n");
      this.thinkingActive = false;
    }
  }

  toolStart(name: string, summary: string): void {
    this.assistantEnd();
    this.thinkingEnd();
    this.spinnerStop();
    this.out.write(`\r\n` + `${style.cyan("⏺")} ${style.bold(name)}${summary ? ` ${style.dim(summary)}` : ""}\r\n`);
    this.lastSpinnerLen = 0;
  }

  toolEnd(_name: string, ok: boolean, summary: string): void {
    const marker = ok ? style.gray("│") : style.red("│");
    const text = summary ? ` ${ok ? style.gray(summary) : style.red(summary)}` : "";
    this.out.write(`  ${marker}${text}\r\n`);
  }

  todos(items: TodoItem[]): void {
    if (items.length === 0) return;
    this.write(`\n${style.bold("Plan")}\n`);
    for (const item of items) {
      const mark =
        item.status === "completed" ? style.green("✓") : item.status === "in_progress" ? style.yellow("▸") : style.gray("○");
      const text = item.status === "completed" ? style.dim(item.content) : item.content;
      this.write(`  ${mark} ${text}\n`);
    }
    this.write("\n");
  }

  spinnerStart(text: string): void {
    this.spinnerStop();
    this.spinnerText = text;
    const tick = () => {
      const line = `${style.cyan(SPINNER_FRAMES[this.spinnerFrame++ % SPINNER_FRAMES.length])} ${style.dim(this.spinnerText)}`;
      this.out.write(`\r${line}`);
      this.lastSpinnerLen = displayWidth(this.spinnerText) + 2;
    };
    tick();
    this.spinnerTimer = setInterval(tick, 80);
  }

  spinnerStop(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.clearSpinnerLine();
  }

  async confirm(question: string): Promise<"yes" | "always" | "no"> {
    this.spinnerStop();
    this.assistantEnd();
    this.thinkingEnd();
    // Inside the REPL, the readline instance is already reading a line - a second
    // reader on stdin would fight it for input. Ask on the existing interface.
    if (this.interactive && this.rl) {
      const original = this.rl.getPrompt();
      this.rl.setPrompt(`${style.cyan("?")} ${question} ${style.dim("[y]es / [a]lways / [n]o")} `);
      const answer = await this.rl.question("");
      this.rl.setPrompt(original);
      this.rl.prompt(true);
      const a = answer.trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (a === "y" || a === "yes" || a === "") return "yes";
      return "no";
    }
    const rl = readline.createInterface({ input: process.stdin, output: this.out });
    try {
      rl.setPrompt(`${style.cyan("?")} ${question} ${style.dim("[y]es / [a]lways / [n]o")} `);
      rl.prompt();
      const answer = await new Promise<string>((resolve) => rl.once("line", resolve));
      const a = answer.trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (a === "y" || a === "yes" || a === "") return "yes";
      return "no";
    } finally {
      rl.close();
    }
  }
}
