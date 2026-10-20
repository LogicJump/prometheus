/** Interactive REPL: slash commands, multiline input, Ctrl-C handling, session autosave. */

import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { Agent } from "./agent.ts";
import type { Config } from "./types.ts";
import type { ChatMessage } from "./types.ts";
import { ChatClient } from "./llm.ts";
import { TerminalUi } from "./ui.ts";
import { ansi as style } from "./render.ts";
import { Permissions } from "./permissions.ts";
import { listSessions, loadSession, newSessionId, saveSession, ForeignSessionWriter, type SessionFile } from "./sessions.ts";
import { acquireSessionLock, releaseSessionLock, lockConflictMessage } from "./sessionLock.ts";
import { CONFIG_HOME, ALLOWED_MODELS, PERMISSION_MODES, validEffort, validMode } from "./config.ts";
import { existsSync } from "node:fs";

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
import { ALL_TOOLS } from "./tools/index.ts";
import { discoverModels } from "./models.ts";
import { recordUsage } from "./usage.ts";

export interface ReplOptions {
  config: Config;
  session?: SessionFile | null;
}

const HELP = `${style.bold("Commands")}
  /help                show this help
  /model [name]        show or switch the model
  /models [refresh]    list models advertised by the endpoint
  /mode [name]         show or switch the permission mode (ask, auto, acceptEdits, plan, dontAsk, bypassPermissions)
  /effort [auto|low|medium|high] show or switch thinking effort
  /plan                shortcut for /mode plan
  /yolo                shortcut for /mode auto (no confirmation prompts)
  /clear               reset the conversation
  /compact [focus]     compact the conversation; focus guides the recap
  /cost                token usage and dollars for this session
  /budget              how much of the configured ceiling is used
  /context             context window usage
  /sessions            list saved sessions
  /resume <id>         load a saved session
  /rewind [n]          undo the last n turns, restoring the files they changed
  /memory              show the memory and instruction files in use
  /init                create a PROMETHEUS.md for this project
  /exit                quit (also Ctrl-D)

${style.bold("Input")}
  Enter submits. End a line with \\ to continue on the next line.
  Esc interrupts the current turn. Ctrl-C at the prompt clears the line; twice exits.`;

export class Repl {
  private readonly ui = new TerminalUi();
  private readonly rl: ReturnType<typeof readline.createInterface>;
  private readonly client: ChatClient;
  private agent: Agent;
  private sessionId: string;
  private config: Config;
  private pendingLines: string[] = [];
  private readonly options: ReplOptions;
  private interrupted = false;
  /** The directory the terminal was opened in, before any worktree switch. */
  private startedIn = process.cwd();

  constructor(options: ReplOptions) {
    this.options = options;
    this.config = options.config;
    this.client = new ChatClient({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      reasoningEffort: this.config.thinkingEffort,
      echoReasoning: Boolean(this.config.echoReasoning),
      timeoutMs: 300_000,
    });
    this.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: true,
      historySize: 500,
      completer: (line: string) => {
        const commands = [
          "/help", "/model", "/models", "/mode", "/effort", "/plan", "/yolo", "/clear", "/compact", "/cost",
          "/context", "/sessions", "/resume", "/rewind", "/memory", "/init", "/exit",
        ];
        if (!line.startsWith("/")) return [[], line];
        return [commands.filter((c) => c.startsWith(line)), line];
      },
    });
    stdin.setRawMode?.(true);
    this.ui.attachReadline(this.rl);
    this.sessionId = options.session?.id ?? newSessionId();
    // A resumed session is still open in some other writer if it is locked;
    // the caller refuses before constructing the REPL, so taking the lock here
    // is what makes this process the owner.
    const claim = acquireSessionLock(this.sessionId, "terminal");
    if (!claim.ok) throw new Error(lockConflictMessage(this.sessionId, claim.holder));
    // A resumed conversation keeps the mode it was saved under.
    if (options.session?.mode) this.config = { ...this.config, permissionMode: options.session.mode };
    if (options.session?.effort) {
      this.config = { ...this.config, thinkingEffort: options.session.effort };
      this.client.options.reasoningEffort = options.session.effort;
    }
    this.agent = this.buildAgent(options.session?.messages ?? []);
    this.wireKeys();
  }

  private buildAgent(messages: ChatMessage[]): Agent {
    const permissions = new Permissions(this.config, this.ui);
    const agent = new Agent(this.config, this.ui, this.client, ALL_TOOLS, permissions, messages);
    // Without this the terminal wrote no checkpoints at all: the id stayed ""
    // and the pipeline skips capture when it is empty, so `rewind` and the
    // checkpoint commands had nothing to restore in a CLI session.
    agent.sessionId = this.sessionId;
    return agent;
  }

  /** Rebuild the agent in place, preserving history and refreshing the system prompt. */
  private rebuildAgent(): void {
    this.agent = this.buildAgent(this.agent.messages);
    this.agent.refreshSystemPrompt();
  }

  private wireKeys(): void {
    stdin.on("keypress", (_str: string, key: readline.Key) => {
      if (key.name === "escape" && this.agent.busy) {
        this.ui.warn("interrupting...");
        this.agent.abort();
      }
    });
  }

  private sessionFile(): SessionFile {
    return {
      id: this.sessionId,
      cwd: process.cwd(),
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: this.agent.messages.filter((m) => m.role !== "system"),
      mode: this.config.permissionMode,
      effort: this.config.thinkingEffort,
      sandbox: this.config.sandbox,
      networkPolicy: this.config.networkPolicy,
      board: this.config.board,
      ...(process.cwd() !== this.startedIn ? { worktree: { path: process.cwd(), branch: `prometheus/${this.sessionId}` } } : {}),
    };
  }

  async start(): Promise<void> {
    // The terminal had no session lifecycle at all: a hook configured for
    // SessionStart or Stop silently never ran, so the CLI and the desktop
    // disagreed about when a session begins.
    void this.agent.fireSessionHooks("SessionStart", { sessionId: this.sessionId });
    this.printBanner();
    void this.listModels(false);

    this.rl.on("SIGINT", () => {
      if (this.agent.busy) {
        this.agent.abort();
        this.ui.warn("turn interrupted");
        return;
      }
      if (this.pendingLines.length > 0) {
        this.pendingLines = [];
        stdout.write("\n");
        this.rl.prompt();
        return;
      }
      // Ctrl-C at an idle prompt: a stray tool line or bubble, so just redraw.
      stdout.write("\n");
      this.rl.prompt(true);
    });

    for (;;) {
      let line: string;
      try {
        line = await this.question(this.promptString());
      } catch {
        break; // stdin closed
      }
      await this.handleLine(line);
      if (this.shouldExit) break;
    }
    saveSession(this.sessionFile());
    // The counterpart to SessionStart: cleanup hooks run while the session id
    // is still meaningful, before the lock is released.
    await this.agent.fireSessionHooks("SessionEnd", { sessionId: this.sessionId });
    this.ui.dim(`Session saved as ${this.sessionId}. Resume with: prometheus --resume ${this.sessionId}`);
    releaseSessionLock(this.sessionId);
    this.ui.detachReadline();
    stdin.setRawMode?.(false);
    this.rl.close();
  }

  private shouldExit = false;

  private promptString(): string {
    const mode = this.config.permissionMode;
    const modeTag =
      mode === "plan" ? style.magenta("plan") : mode === "auto" ? style.green("auto") : style.yellow("ask");
    const using = this.pendingLines.length > 0 ? style.dim("… ") : "";
    return `${using}${style.cyan("›")} ${style.gray(`[${modeTag}${style.gray(` ${this.config.model}`)}]`)} `;
  }

  private async question(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const onClose = () => reject(new Error("closed"));
      this.rl.once("close", onClose);
      this.rl.setPrompt(prompt);
      this.rl.question("", (answer) => {
        this.rl.removeListener("close", onClose);
        resolve(answer);
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    const raw = line;
    line = line.replace(/\x1b\[13;2u/g, "");
    // Multiline continuation: trailing backslash, or Shift+Enter (emitted as \n inside the line).
    if (line.endsWith("\\")) {
      this.pendingLines.push(line.replace(/\\$/, ""));
      this.rl.setPrompt(style.dim("… "));
      this.rl.prompt(true);
      return;
    }
    const isContinuation = this.pendingLines.length > 0;
    const full = [...this.pendingLines, line].join("\n").trim();
    this.pendingLines = [];
    if (!raw) return;
    if (isContinuation) this.rl.setPrompt(this.promptString());
    if (!full) return;

    if (full.startsWith("/")) {
      await this.command(full);
      return;
    }

    if (this.agent.busy) {
      this.ui.warn("a turn is already running - press Esc to interrupt");
      return;
    }

    this.ui.echoUser(full);

    // The desktop host persists mid-turn; the terminal waited for the turn to
    // end, so a kill during a long build lost everything the agent had done.
    // A five-second cadence is cheap (the writer appends only new messages).
    const autosave = setInterval(() => {
      try {
        saveSession(this.sessionFile());
      } catch {
        /* a transient write failure must not interrupt the turn */
      }
    }, 5000);
    autosave.unref?.();

    const usageBefore = { ...this.agent.usage };
    const beforeBySource = {
      subagent: { ...this.agent.usageBySource.subagent },
      background: { ...this.agent.usageBySource.background },
    };
    try {
      await this.agent.run(full);
    } catch (err) {
      this.ui.error(formatError(err));
    } finally {
      clearInterval(autosave);
      // The interactive CLI used to account for nothing, so every terminal
      // session was invisible in the Usage page while the desktop recorded
      // itself. One line per source per turn, the same shape the host writes.
      try {
        const delta = {
          inputTokens: this.agent.usage.inputTokens - usageBefore.inputTokens,
          outputTokens: this.agent.usage.outputTokens - usageBefore.outputTokens,
          cachedTokens: this.agent.usage.cachedTokens - usageBefore.cachedTokens,
          cacheWriteTokens: (this.agent.usage.cacheWriteTokens ?? 0) - (usageBefore.cacheWriteTokens ?? 0),
        };
        if (delta.inputTokens !== 0 || delta.outputTokens !== 0) {
          recordUsage({ sessionId: this.sessionId, cwd: process.cwd(), model: this.agent.lastUsedModel || this.config.model, ...delta });
        }
        for (const kind of ["subagent", "background"] as const) {
          const spent = this.agent.usageBySource[kind];
          const part = {
            inputTokens: spent.inputTokens - beforeBySource[kind].inputTokens,
            outputTokens: spent.outputTokens - beforeBySource[kind].outputTokens,
            cachedTokens: spent.cachedTokens - beforeBySource[kind].cachedTokens,
            cacheWriteTokens: (spent.cacheWriteTokens ?? 0) - (beforeBySource[kind].cacheWriteTokens ?? 0),
          };
          if (part.inputTokens !== 0 || part.outputTokens !== 0) {
            recordUsage({ sessionId: this.sessionId, cwd: process.cwd(), model: this.agent.lastUsedModel || this.config.model, ...part, source: kind });
          }
        }
      } catch {
        /* accounting must never break a turn */
      }
      try {
        saveSession(this.sessionFile());
      } catch (err) {
        // The agent error above is the interesting one; this is only reached
        // when the transcript was taken over while the turn was running.
        if (err instanceof ForeignSessionWriter) this.ui.error(err.message);
        else throw err;
      }
      if (this.ui.takeLineDirty?.()) stdout.write("\r\n");
    }
  }

  private async command(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        this.ui.info(HELP);
        return;
      case "exit":
      case "quit":
        this.shouldExit = true;
        return;
      case "yolo":
        this.config = { ...this.config, permissionMode: "auto" };
        this.rebuildAgent();
        this.ui.warn("auto mode: mutating tools now run without confirmation");
        return;
      case "clear":
        this.sessionId = newSessionId();
        // The old order built the agent first, so the new agent carried the
        // previous session's id and checkpointed into the wrong history.
        this.agent = this.buildAgent([]);
        acquireSessionLock(this.sessionId, "terminal");
        this.ui.dim("conversation cleared");
        return;
      case "model":
        if (!arg) {
          const source = this.catalogSource ? `\nmodels (${this.catalogSource})` : "";
          this.ui.info(
            `model: ${this.config.model}\nbase URL: ${this.config.baseUrl}` +
              `${source}\nallowed: ${ALLOWED_MODELS.length ? ALLOWED_MODELS.join(", ") : "all advertised by the endpoint"}`,
          );
        } else if (!ALLOWED_MODELS.includes(arg) && ALLOWED_MODELS.length > 0) {
          this.ui.error(`model "${arg}" is not permitted. Allowed: ${ALLOWED_MODELS.join(", ")}`);
        } else {
          this.config = { ...this.config, model: arg };
          this.client.options.model = arg;
          this.rebuildAgent();
          this.ui.dim(`model set to ${arg}`);
        }
        return;
      case "models":
        await this.listModels(arg === "refresh");
        return;
      case "mode": {
        // Every mode the permission layer implements; this accepted three and
        // told the user the others did not exist.
        const mode = validMode(arg);
        if (!mode) {
          this.ui.info(`mode: ${this.config.permissionMode} (use /mode ${PERMISSION_MODES.join("|")})`);
          return;
        }
        this.config = { ...this.config, permissionMode: mode };
        this.rebuildAgent();
        this.ui.dim(`mode set to ${mode}`);
        return;
      }
      case "effort": {
        // The levels are the model's own, discovered from the endpoint; the
        // REPL names the ones it knows and accepts anything else the user's
        // gateway advertises rather than refusing a spelling this build has
        // never seen.
        const level = validEffort(arg);
        if (!level) {
          const available = this.modelEfforts().join("|");
          this.ui.info(`thinking effort: ${this.config.thinkingEffort} (use /effort auto|${available})`);
          return;
        }
        this.config = { ...this.config, thinkingEffort: level };
        this.client.options.reasoningEffort = level;
        this.ui.dim(`thinking effort set to ${level}`);
        return;
      }
      case "plan":
        this.config = { ...this.config, permissionMode: "plan" };
        this.rebuildAgent();
        this.ui.dim("plan mode: read-only investigation. Use /mode ask to allow edits.");
        return;
      case "budget": {
        const u = this.agent.usage;
        const total = u.inputTokens + u.outputTokens;
        const spent = this.agent.sessionCost();
        const money = this.config.maxBudgetUsd;
        const tokens = this.config.sessionTokenBudget;
        const lines = [
          `spent: ${spent === null ? "unknown (model has no price)" : `$${spent.toFixed(4)}`}` +
            (money ? ` of $${money.toFixed(2)}` : " (no money ceiling)"),
          `tokens: ${total.toLocaleString()}${tokens ? ` of ${tokens.toLocaleString()}` : " (no token ceiling)"}`,
        ];
        this.ui.info(lines.join("\n"));
        return;
      }
      case "cost": {
        const u = this.agent.usage;
        const total = u.inputTokens + u.outputTokens;
        // Dollars are what a budget is expressed in, so the answer to "what
        // did this cost" has to include them; the command used to report only
        // tokens, which left the user doing the multiplication themselves.
        const spent = this.agent.sessionCost();
        this.ui.info(
          `tokens: ${u.inputTokens.toLocaleString()} in (${u.cachedTokens.toLocaleString()} cached), ${u.outputTokens.toLocaleString()} out, ${total.toLocaleString()} total` +
            `
cost: ${spent === null ? "unknown (model has no price)" : `$${spent.toFixed(4)}`}`,
        );
        return;
      }
      case "context": {
        const usage = this.agent.contextUsage();
        this.ui.info(`context: ~${usage.tokens.toLocaleString()} tokens (${usage.percent}% of ${this.config.contextWindow.toLocaleString()})`);
        return;
      }
      case "compact": {
        const before = this.agent.contextUsage().tokens;
        try {
          // The model writes the recap and the argument is passed through as
          // the focus, so `/compact keep the API decisions` means something.
          // Two optional parts: a focus for the summary and a number of
          // recent messages to keep verbatim. Both are free-form, so they are
          // pulled out of the argument text by their shape.
          const keepMatch = /(?:^|\s)--keep(?:=|\s+)(\d+)/.exec(arg);
          const keepRecent = keepMatch ? Number(keepMatch[1]) : undefined;
          const focus = arg.replace(/(?:^|\s)--keep(?:=|\s+)\d+/, "").trim();
          const result = await this.agent.compactNow({
            ...(focus ? { focus } : {}),
            ...(keepRecent ? { keepRecent } : {}),
          });
          if (!result) this.ui.dim("nothing to compact");
          else this.ui.dim(`compacted (${result.level}, ~${before} -> ~${this.agent.contextUsage().tokens} tokens)`);
        } catch (err) {
          this.ui.warn(formatError(err));
        }
        return;
      }
      case "sessions": {
        const sessions = listSessions(false).slice(0, 20);
        if (sessions.length === 0) {
          this.ui.dim("no saved sessions");
          return;
        }
        for (const s of sessions) {
          this.ui.info(`${style.cyan(s.id)}  ${style.dim(s.updatedAt)}  ${s.summary}`);
        }
        return;
      }
      case "resume": {
        if (!arg) {
          this.ui.warn("usage: /resume <session-id>");
          return;
        }
        const session = loadSession(arg);
        if (!session) {
          this.ui.error(`session not found: ${arg}`);
          return;
        }
        // The current session keeps its lock only until the switch succeeds:
        // releasing first would leave both sessions writable for a moment.
        const claim = acquireSessionLock(session.id, "terminal");
        if (!claim.ok) {
          this.ui.error(lockConflictMessage(session.id, claim.holder));
          return;
        }
        releaseSessionLock(this.sessionId);
        this.sessionId = session.id;
        this.config = { ...this.config, model: session.model };
        // A resumed conversation runs with the settings it was saved under.
        if (session.mode) this.config = { ...this.config, permissionMode: session.mode };
        if (session.effort) this.config = { ...this.config, thinkingEffort: session.effort };
        this.client.options.model = session.model;
        if (session.effort) this.client.options.reasoningEffort = session.effort;
        // A worktree session is only meaningful inside its worktree; entering
        // it here keeps the resumed conversation pointed at the files it edited.
        if (session.worktree && existsSyncSafe(session.worktree.path)) {
          process.chdir(session.worktree.path);
        } else {
          // Resuming outside the worktree it was created in must not leave the
          // next save claiming the current folder is that worktree.
          this.startedIn = process.cwd();
        }
        if (session.board) this.config = { ...this.config, board: session.board };
        this.agent = this.buildAgent(session.messages);
        const restored = [session.mode ? `${session.mode} mode` : "", session.effort ? `${session.effort} effort` : ""].filter(Boolean);
        this.ui.dim(`resumed ${session.id} (${session.messages.length} messages${restored.length ? `, ${restored.join(", ")}` : ""})`);
        return;
      }
      case "rewind": {
        // Undo the last turn: drop the messages it added and restore the files
        // those turns changed. The terminal had no rewind at all, while the
        // desktop did, so the same mistake cost more here.
        const removedText = arg.trim();
        if (!removedText) {
          this.ui.warn("usage: /rewind [number-of-user-turns]  (default 1)");
          return;
        }
        if (this.agent.busy) {
          this.ui.warn("stop the running turn first (Esc)");
          return;
        }
        const count = Math.max(1, Math.min(20, Number(removedText) || 1));
        // Find the user turn to rewind to, counting backwards from the end.
        let index = this.agent.messages.length;
        for (let found = 0; found < count && index > 0; found++) {
          index -= 1;
          while (index > 0 && this.agent.messages[index].role !== "user") index -= 1;
        }
        if (index <= 0) {
          this.ui.warn("nothing to rewind");
          return;
        }
        const { restoreAfterMessage } = await import("./checkpoints.ts");
        const files = restoreAfterMessage(this.sessionId, index);
        this.agent.messages = this.agent.messages.slice(0, index);
        try {
          saveSession(this.sessionFile());
        } catch {
          /* the in-memory rewind already happened; the next save will retry */
        }
        this.ui.dim(
          `rewound ${count} turn(s)` +
            (files.restored.length ? `, restored ${files.restored.length} file(s)` : "") +
            (files.errors.length ? `; ${files.errors.join("; ")}` : ""),
        );
        return;
      }
      case "memory": {
        this.ui.info(`global: ${CONFIG_HOME}\\memory\\global.md\nproject: ${CONFIG_HOME}\\memory\\<project>.md\ninstructions: PROMETHEUS.md / AGENTS.md / CLAUDE.md`);
        return;
      }
      case "init":
        await this.initProject();
        return;
      default:
        this.ui.warn(`unknown command: /${cmd} - try /help`);
    }
  }

  private catalogSource = "";
  /** Reasoning levels advertised for the active model, low to high. */
  private catalogEfforts: string[] = [];

  private modelEfforts(): string[] {
    return this.catalogEfforts.length > 0 ? this.catalogEfforts : ["low", "medium", "high"];
  }

  private async listModels(refresh: boolean): Promise<void> {
    const catalog = await discoverModels(this.config.baseUrl, this.config.apiKey, { force: refresh });
    this.catalogSource = catalog.source;
    this.catalogEfforts = catalog.models.find((model) => model.id === this.config.model)?.reasoningEfforts ?? [];
    if (catalog.models.length === 0) {
      this.ui.warn("no models were advertised by the endpoint");
      return;
    }
    const lines = catalog.models.map((model) => {
      const mark = model.id === this.config.model ? style.green("●") : style.gray("○");
      const meta = [
        model.contextLength ? `${Math.round(model.contextLength / 1000)}K ctx` : "",
        model.supportsReasoning ? "reasoning" : "",
        model.supportsVision ? "vision" : "",
        // The levels are the reason a per-model picker is needed; naming them
        // here is what tells the user that `/effort max` will be accepted.
        model.reasoningFixed
          ? `effort ${model.reasoningFixed} (fixed)`
          : model.reasoningEfforts
            ? `effort ${model.reasoningEfforts.join("/")}`
            : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `  ${mark} ${style.cyan(model.id)}${meta ? `  ${style.dim(meta)}` : ""}`;
    });
    this.ui.info(`${style.bold("Models")} ${style.dim(`(${catalog.source})`)}\n${lines.join("\n")}\n\nSwitch with /model <id>`);
  }

  private async initProject(): Promise<void> {
    const prompt =
      "Create a PROMETHEUS.md file in the workspace root. Inspect the repository structure and key config files first. " +
      "Document: what the project is, the build/test/lint commands, the directory layout, and conventions an agent must follow. " +
      "Keep it under 120 lines. Do not invent commands you have not confirmed exist.";
    try {
      await this.agent.run(prompt);
      this.ui.dim("PROMETHEUS.md created");
    } catch (err) {
      this.ui.error(formatError(err));
    }
  }

  private printBanner(): void {
    const u = this.agent.usage;
    void u;
    stdout.write(`
${style.bold("Prometheus")} ${style.dim("v0.1")}
${style.dim(`${this.config.model} · ${this.config.baseUrl}`)}
${style.dim(`${this.config.permissionMode} mode · ${process.cwd()}`)}
${style.dim("Type /help for commands. Esc interrupts a turn.")}
`);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "turn interrupted";
    return err.message;
  }
  return String(err);
}
