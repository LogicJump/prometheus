/**
 * The six permission modes, as the user switches between them.
 *
 * The modes themselves were implemented; the plumbing between the UI and the
 * permission layer was not, and that is what made them feel broken:
 *
 *   - the desktop host's `setMode` accepted three names, so choosing
 *     acceptEdits / dontAsk / bypassPermissions in the composer closed the
 *     menu and changed nothing;
 *   - saving any unrelated setting reloaded config from disk and then kept the
 *     live mode only for those same three names, silently reverting the other
 *     three;
 *   - `--mode acceptEdits` was a usage error from a build that implemented it;
 *   - `--dont-ask` set `autoApprove: ["*"]`, so the flag meaning "do not ask"
 *     also meant "yes" — ask mode wrote files without approval;
 *   - `bypassPermissions` returned before the critical-command breakers and
 *     `--disallowed-tools`, although its own comment says it respects both.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "prometheus-modes-"));
process.env.PROMETHEUS_HOME = home;

const { PERMISSION_MODES, isPermissionMode, validMode } = await import("../src/config.ts");
const { Permissions } = await import("../src/permissions.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

const writeTool = {
  name: "write_file",
  description: "",
  parameters: {},
  readonly: false,
  summarize: (input) => String(input.path ?? ""),
  execute: async () => ({ content: "" }),
} as never;

const bashTool = {
  name: "bash",
  description: "",
  parameters: {},
  readonly: false,
  summarize: (input) => String(input.command ?? ""),
  execute: async () => ({ content: "" }),
} as never;

const readTool = {
  name: "read_file",
  description: "",
  parameters: {},
  readonly: true,
  summarize: (input) => String(input.path ?? ""),
  execute: async () => ({ content: "" }),
} as never;

/** A UI that answers every prompt the same way and records that it was asked. */
function scriptedUi(answer: "yes" | "no" | "always" = "no") {
  const asked: string[] = [];
  return {
    asked,
    ui: {
      info() {},
      dim() {},
      warn() {},
      error() {},
      assistantText() {},
      assistantEnd() {},
      toolStart() {},
      toolEnd() {},
      thinking() {},
      thinkingEnd() {},
      todos() {},
      spinnerStart() {},
      spinnerStop() {},
      async confirm(question: string) {
        asked.push(question);
        return answer;
      },
      async ask() {
        return "always-detail";
      },
    } as never,
  };
}

function permissions(mode: string, extra: Record<string, unknown> = {}, answer: "yes" | "no" | "always" = "no") {
  const scripted = scriptedUi(answer);
  const config = {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m",
    maxTokens: 1000,
    permissionMode: mode,
    contextWindow: 128000,
    maxTurns: 10,
    allowedDirs: [],
    autoApprove: [],
    sandbox: "enforce",
    networkPolicy: "off",
    ...extra,
  } as never;
  return { manager: new Permissions(config, scripted.ui), asked: scripted.asked };
}

test("the mode list is defined once and every name resolves", () => {
  assert.deepEqual([...PERMISSION_MODES], ["ask", "auto", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);
  for (const mode of PERMISSION_MODES) {
    assert.equal(validMode(mode), mode);
    assert.equal(isPermissionMode(mode), true);
  }
  // The parser is case-insensitive, as config files and flags are.
  assert.equal(validMode("ACCEPTEDITS"), "acceptEdits");
  assert.equal(isPermissionMode("nonsense"), false);
});

test("the desktop host accepts every mode, not three", () => {
  const host = readFileSync("desktop/host.js", "utf8");
  // A hand-written three-name list in `setMode` dropped the other three on the
  // floor: the menu closed, the label changed, and the host stayed put.
  const setMode = host.slice(host.indexOf('case "setMode"'), host.indexOf('case "setModel"'));
  assert.match(setMode, /isPermissionMode\(cmd\.mode\)/);
  assert.ok(!/\["ask", "auto", "plan"\]/.test(setMode), "setMode must not carry its own list");
  // Saving an unrelated setting reloads config from disk; the live mode has to
  // survive that for every mode, not only the original three.
  assert.match(host, /if \(!isPermissionMode\(patch\.mode\)\) config\.permissionMode = liveMode;/);
});

test("the CLI and the REPL accept every mode", () => {
  const cli = readFileSync("bin/prometheus.js", "utf8");
  assert.match(cli, /if \(mode && !isPermissionMode\(mode\)\)/);
  assert.ok(!/mode !== "ask" && mode !== "auto"/.test(cli));
  const repl = readFileSync("src/repl.ts", "utf8");
  assert.match(repl, /const mode = validMode\(arg\);/);
  assert.ok(!/mode !== "ask" && mode !== "auto" && mode !== "plan"/.test(repl));
});

test("--dont-ask does not grant anything", () => {
  const cli = readFileSync("bin/prometheus.js", "utf8");
  // `autoApprove: ["*"]` made "do not ask" mean "yes": ask mode wrote files
  // with no approval, and dontAsk — the mode named for refusing — allowed
  // everything.
  assert.ok(!/dont-ask"\]\s*\?\s*\{\s*autoApprove:\s*\["\*"\]/.test(cli));
  // The unattended block now only sets the flag; a `\r` in the checkout must
  // not make the assertion depend on the line ending.
  assert.match(cli, /unattended: true,?\s*\};/);
});

test("ask mode asks before a write, and refuses when nobody answers", async () => {
  const { manager, asked } = permissions("ask", { unattended: true });
  const verdict = await manager.check(writeTool, { path: "a.txt" });
  assert.equal(verdict.allowed, false);
  assert.equal(asked.length, 0, "an unattended run cannot prompt");
  assert.match(verdict.reason ?? "", /--allowed-tools/);
});

test("acceptEdits lets a file edit through but still asks for a command", async () => {
  const { manager, asked } = permissions("acceptEdits", { unattended: true });
  assert.equal((await manager.check(writeTool, { path: "a.txt" })).allowed, true);
  // A command is not an edit; unattended, it is refused rather than run.
  const command = await manager.check(bashTool, { command: "npm test" });
  assert.equal(command.allowed, false);
});

test("dontAsk refuses instead of prompting, in every case", async () => {
  const { manager, asked } = permissions("dontAsk");
  const verdict = await manager.check(writeTool, { path: "a.txt" });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /dontAsk/);
  assert.equal(asked.length, 0, "dontAsk exists to avoid the prompt");
});

test("plan mode allows reads and refuses edits", async () => {
  const { manager } = permissions("plan");
  assert.equal((await manager.check(readTool, { path: "a.txt" })).allowed, true);
  assert.equal((await manager.check(writeTool, { path: "a.txt" })).allowed, false);
});

test("bypassPermissions still obeys --disallowed-tools and the critical-command breakers", async () => {
  // Its own comment says it does; the early return above both checks said
  // otherwise, so the one mode described as "no prompts at all" was also the
  // one that could delete the workspace root.
  const forbidden = permissions("bypassPermissions", { disallowedTools: ["write_file"] });
  assert.equal((await forbidden.manager.check(writeTool, { path: "a.txt" })).allowed, false);

  const destructive = permissions("bypassPermissions");
  const verdict = await destructive.manager.check(bashTool, { command: "rm -rf ." });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /refus/i);
});

test("bypassPermissions still does not ask for an ordinary call", async () => {
  const { manager, asked } = permissions("bypassPermissions");
  assert.equal((await manager.check(writeTool, { path: "a.txt" })).allowed, true);
  assert.equal((await manager.check(bashTool, { command: "npm test" })).allowed, true);
  assert.equal(asked.length, 0);
});
