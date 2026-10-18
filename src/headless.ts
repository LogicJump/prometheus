/**
 * A UI that emits JSON instead of drawing a terminal.
 *
 * The headless mode (`--output-format json` / `stream-json`) needs the same
 * turn the interactive UI sees, in a shape another program can consume. This
 * class implements the `Ui` surface and writes one object per line, so
 * `stream-json` is genuinely streaming: a consumer can render tool activity
 * while the turn is still running.
 *
 * Two modes:
 *   json         buffer everything, print one object at the end
 *   stream-json  print one object per event as it happens (JSONL)
 *
 * In both, stdout carries only the objects. Progress that a person would see
 * but a program cannot use (spinners, dim notices) is dropped, so a caller can
 * pipe stdout straight into `jq`.
 */

import type { TodoItem, Ui } from "./types.ts";

export interface HeadlessEvent {
  type: string;
  [key: string]: unknown;
}

export class JsonUi implements Ui {
  private readonly stream: boolean;
  private readonly out: NodeJS.WriteStream;
  readonly events: HeadlessEvent[] = [];
  private text = "";
  private thought = "";
  /** Set when a permission prompt arrives; headless runs cannot answer one. */
  denied = 0;

  constructor(options: { stream?: boolean; out?: NodeJS.WriteStream } = {}) {
    this.stream = Boolean(options.stream);
    this.out = options.out ?? process.stdout;
  }

  private emit(event: HeadlessEvent): void {
    if (this.stream) {
      this.out.write(`${JSON.stringify(event)}\n`);
      return;
    }
    this.events.push(event);
  }

  info(): void {}
  dim(): void {}
  warn(text: string): void {
    this.emit({ type: "warning", text });
  }
  error(text: string): void {
    this.emit({ type: "error", text });
  }

  assistantText(delta: string): void {
    this.text += delta;
    if (this.stream) this.emit({ type: "assistant_delta", text: delta });
  }

  assistantEnd(): void {
    if (this.text) this.emit({ type: "assistant", text: this.text });
    this.text = "";
  }

  thinking(delta: string): void {
    this.thought += delta;
  }

  thinkingEnd(): void {
    if (this.thought) this.emit({ type: "thinking", text: this.thought });
    this.thought = "";
  }

  toolStart(name: string, summary: string): void {
    this.assistantEnd();
    this.emit({ type: "tool_start", name, summary });
  }

  toolEnd(name: string, ok: boolean, summary: string): void {
    this.emit({ type: "tool_end", name, ok, summary });
  }

  toolOutput(name: string, content: string): void {
    if (this.stream) this.emit({ type: "tool_output", name, text: content.slice(0, 20_000) });
  }

  todos(items: TodoItem[]): void {
    this.emit({ type: "plan", items });
  }

  subagentStart(prompt: string): void {
    this.emit({ type: "subagent_start", prompt });
  }

  subagentActivity(kind: "tool" | "text", text: string): void {
    this.emit({ type: "subagent_activity", kind, text });
  }

  subagentEnd(ok: boolean, summary: string): void {
    this.emit({ type: "subagent_end", ok, summary });
  }

  /**
   * Headless runs are non-interactive. A tool that would prompt is refused
   * with a readable reason, which the model sees and can adapt to, instead of
   * the process blocking on a terminal that is not there.
   */
  async confirm(): Promise<"yes" | "always" | "no"> {
    this.denied += 1;
    return "no";
  }

  spinnerStart(): void {}
  spinnerStop(): void {}
  setModelName(): void {}
  echoUser(): void {}
  takeLineDirty(): boolean {
    return false;
  }

  /** Everything collected in `json` mode, in the order a reader expects. */
  result(): HeadlessEvent[] {
    return this.events;
  }
}
