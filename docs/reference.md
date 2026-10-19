# Reference

Configuration, flags, tool descriptions, and the smaller subsystems. The
[README](../README.md) covers what Prometheus is; this page covers how to drive
it.

## Configuration

Put the endpoint and key in `~/.prometheus/config.json`:

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "glm-5.3-flash"
}
```

Or name a provider from the registry and let it supply the base URL:

```json
{ "provider": "deepseek", "apiKey": "sk-...", "model": "deepseek-chat" }
```

Built-in providers live in `src/providers.ts` (OpenAI, DeepSeek, Moonshot,
Qwen, Ollama, OpenRouter). Add your own in `~/.prometheus/providers.json`:

```json
{ "providers": [{ "id": "company", "label": "Company gateway", "baseUrl": "https://ai.example.com/v1", "apiKeyEnv": ["COMPANY_AI_KEY"] }] }
```

Environment variables override the file: `PROMETHEUS_BASE_URL`,
`PROMETHEUS_API_KEY` (or `OPENAI_API_KEY`), `PROMETHEUS_MODEL`,
`PROMETHEUS_PROVIDER`. A project can override settings in
`.prometheus/config.json`.

The model picker offers whatever the endpoint advertises on `GET /models`, and
auto-discovery is cached for an hour (`~/.prometheus/models-cache.json`). Set
`PROMETHEUS_MODELS=glm-5.3-flash,deepseek-v4.1-flash` to restrict the list to
those ids.

### Files under `~/.prometheus/`

| File | Purpose |
| --- | --- |
| `config.json` | Endpoint, key, model, mode |
| `providers.json` | Additional provider definitions |
| `mcp.json` | User-scope MCP servers |
| `hooks.json` | User-scope hooks |
| `instructions.md` | Global instructions injected into every run |
| `rules/*.md` | Path-scoped rules |
| `memory/global.md` | User-level memory written by `remember` |
| `memory/<hash>.md` | Per-project memory |
| `audit.log` | Permission decision log |
| `sessions/<id>/` | Conversation transcripts, plus a `.lock` naming the process that has it open |
| `models-cache.json` | Discovered model list, one-hour TTL |

## CLI flags

| Flag | Meaning |
| --- | --- |
| `-m, --model <name>` | Model id |
| `--base-url <url>` | OpenAI-compatible base URL |
| `--key <key>` | API key |
| `--mode <ask\|auto\|plan>` | Permission mode |
| `--effort <level>` | Thinking effort for models that support it |
| `-r, --resume <id>` | Resume a saved session |
| `-c, --continue` | Resume the most recently active session in this directory (pinned sessions do not jump the queue) |
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` |
| `--output-schema <file>` | Check the final answer against a JSON Schema; a mismatch exits non-zero |
| `--allowed-tools <list>` | Tools approved without asking in a one-shot run (comma-separated) |
| `--dont-ask` | Approve every tool in a one-shot run (dangerous; sandbox the job) |
| `--max-budget-usd <n>` | Stop between turns once the run has spent this much |
| `--max-tokens <n>` | Per-response cap (default 16000) |
| `--context-window <n>` | Compaction threshold (default 128,000; `PROMETHEUS_CONTEXT_WINDOW` also works) |
| `--max-turns <n>` | Tool-loop cap per message (default 60) |

### REPL commands

`/help`, `/model [name]`, `/mode [ask|auto|plan]`, `/plan`, `/yolo`, `/clear`,
`/compact [focus]`, `/cost`, `/context`, `/sessions`, `/resume <id>`, `/memory`,
`/init`, `/exit`. End a line with `\` to continue it. Esc interrupts a running
turn.

`/compact` asks the model for the recap (the same path automatic compaction
uses) and takes an optional focus: `/compact keep the API decisions` weights the
summary toward what you name. The CLI and REPL record every turn's usage to
`usage.jsonl`, split by main loop, sub-agents and background tasks.

### Headless

For scripts and CI, `--output-format` swaps the terminal renderer for one that
emits objects. `stream-json` prints one JSON line per event as it happens.

```bash
prometheus --output-format json "summarise the changes on this branch" | jq -r .text
prometheus --output-format stream-json --mode auto "run the tests and fix what fails"
prometheus --max-budget-usd 0.50 "refactor src/context.ts"
```

`--output-schema` checks the final answer against a JSON Schema. The payload
carries `schemaValid` and `schemaError`, and a mismatch exits non-zero so a
wrapping script can branch on it.

A one-shot run has nobody to answer a permission prompt. It does not block
waiting for input that will never come: a tool that would ask is refused, and
the reason names the grant that would have allowed it. Pass
`--allowed-tools bash,edit_file` to approve specific tools for the run, or
`--dont-ask` to approve everything (only in a sandbox you control). If any call
was refused for lack of approval, the run exits non-zero even when the turn
itself completed.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` | Numbered lines, with offset/limit and a binary-file guard |
| `write_file` | Create or overwrite a file |
| `edit_file` | Match ladder (exact → whitespace → indent → anchor), multi-edit and SEARCH/REPLACE patches, atomic per call |
| `list_files` | Shallow tree view |
| `glob` | Find files by pattern (`**/*.ts`, brace expansion) |
| `grep` | Content search; uses ripgrep when installed |
| `search_codebase` | Rank files by declarations and keywords from a cached workspace index |
| `bash` | Shell commands with timeout, output cap, and the sandbox policy |
| `todo_write` | Maintain the visible task plan |
| `remember` | Persist a durable fact |
| `delegate` | Run one sub-agent, up to four in parallel with `prompts`, or with `background: true` |
| `mcp_read_resource` | Read a resource an MCP server advertises (present only when a server has one) |

All file tools resolve paths and refuse anything outside the workspace (plus
`allowedDirs` from config). The check resolves the real path, so a Windows
junction or a symlink that points elsewhere is refused too — a lexical test
would let it through. Shell commands are classified by `src/sandbox.ts`:
destructive commands are denied, risky ones raise a confirmation, and the rest
run. Permission choices can be saved as persistent rules.

The sandbox is a **policy layer, not an OS sandbox**. Two consequences worth
knowing:

- An inline program (`python -c`, `node -e`, `powershell -Command`) cannot be
  inspected by a path scan, so it always asks for confirmation, and one that
  reaches the network is denied when the network policy is `off`. Judging a
  script's body is a regex contest the defender loses; asking is the honest
  answer.
- A command that changes directory outside the workspace and then runs relative
  paths (`cd / && cat etc/passwd`, `cd .. && cat ../../Windows/win.ini`) is
  denied outright: after the `cd`, the path scan has no way to know what a
  relative path resolves to. `cd src && npm test` is unaffected.
- `networkPolicy: "proxy"` is not implemented. A fetcher under that policy
  raises a confirmation saying so rather than silently behaving like `off`.

Two rules sit above every saved approval:

- **Protected paths** — `.git`, `.vscode`, `.idea`, `.prometheus`, `.ssh`,
  `.gnupg`, `.aws`, and shell profiles ask in every mode, including `auto`,
  because editing them changes how the agent itself runs. The check applies to
  the absolute path, so `~/.ssh/config` is covered even when the workspace is
  somewhere else.
- **Critical commands** — deleting the workspace root, the home directory, or a
  drive root are refused outright; no saved approval can authorise them.

On Windows, every `bash` call also runs inside a job object, and the job is
terminated when the call returns. This is what stops a build that leaves a
watcher running, or an install whose postinstall script keeps going after the
turn was aborted: the policy layer only reads the command line, while the job
acts on the process tree. Two limits are worth knowing. A host that already runs
the agent inside a job may refuse the assignment (`ERROR_ACCESS_DENIED`); the
tool then falls back to `taskkill /T`, which reaches ordinary descendants but
not one that asked to detach with `start /b`. And AppContainer is not offered:
`CreateAppContainerProfile` is unavailable on supported hosts, so claiming the
mode would be a lie.

## Sessions

A conversation is stored as an append-only JSONL transcript plus a small meta
file. Only one process writes a session at a time: opening it records a lock
naming the process, and a second writer is refused rather than interleaving its
appends with the first (`prometheus --resume` says which process has it). The
lock is released on exit; a lock left by a process that no longer exists is
cleared and the session opens normally.

A session also remembers the settings it ran with — mode, thinking effort,
sandbox and network policy, board selection — and restoring it applies them.
Reopening a plan-mode investigation does not quietly hand it write access.

The desktop writes the transcript during a running turn (every few seconds),
not only at the end, so a crash or a closed window loses at most the last
exchange rather than the whole turn.

The desktop runs one instance. Opening it again focuses the existing window
instead of starting a second copy that would fight over the tray icon, the
global shortcut and the remembered workspace. Within that instance you can open
more than one window — each runs its own agent host — and each window works on a
different session. The sidebar loads the newest 80 conversations and offers a
"show older" row for the rest; search covers what is loaded.

## Hooks

`~/.prometheus/hooks.json` or `<workspace>/.prometheus/hooks.json` runs local
commands around agent activity. Each hook receives a JSON payload on stdin; a
failing `PreToolUse` hook blocks the tool and its output is returned to the
model as the reason. `PreCompact` runs before a compaction rewrites the
transcript and a non-zero exit cancels it, which is how a hook can save context
before it is lost.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "^bash$", "command": "./scripts/guard.sh" }],
    "PostToolUse": [{ "command": "npm run lint --silent" }],
    "Stop": [{ "command": "echo turn finished" }]
  }
}
```

**Project hooks need approval.** A hook is an arbitrary command that runs with
your account's permissions, and a cloned repository can ship one. So the
workspace file only runs after you accept it: Settings → Hooks shows every
command and has one switch. The acceptance is recorded in
`~/.prometheus/trusted-hooks.json` against a hash of the file, so editing or
adding a hook asks again. Global hooks (`~/.prometheus/hooks.json`) are yours
already and always run without a prompt.

## MCP servers

Stdio and Streamable HTTP servers listed in `~/.prometheus/mcp.json` (user
scope) or `<workspace>/.prometheus/mcp.json` (project scope, overrides by name)
contribute their tools to the agent. A resource is read from the server that
advertised it, never from another server by position.

```json
{
  "servers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

**Authorization.** A remote server that answers `401` with a
`WWW-Authenticate: Bearer` challenge is authorized through OAuth: Prometheus
reads the protected-resource metadata, discovers the authorization server,
registers itself, and runs the authorization-code flow with PKCE in your
browser. The token is written to `~/.prometheus/mcp-tokens.json` (mode 600),
never into `mcp.json`, so the config can be committed. A refresh token is used
silently when it exists; delete the entry in that file to sign out. Servers
whose credentials come from `headers` or `env` never reach this path.

**Tool lists stay current.** A server that sends
`notifications/tools/list_changed` is re-listed immediately and its tools are
replaced in the running session, so a tool it added is usable without a
restart, and one it removed stops being offered.

**Large tool sets are deferred.** Every tool schema is part of every request,
and a few MCP servers can add tens of thousands of tokens. Past ten MCP tools,
their schemas are withheld and a `tool_search` tool is offered instead;
searching returns the matching schemas and makes those tools callable for the
rest of the session. A small set is left in place, because the search round
trip would cost more than the schemas do.

**Prompts are fetched, not described.** `/name arg` on a prompt advertised by a
server calls `prompts/get` and sends the server's own messages. If the server
lists a prompt but cannot serve it, the message says so instead of silently
sending the prompt's name as the body.

**Elicitation.** A server may ask a question mid-call. It is shown through the
same approval UI the agent uses, and is declined when nobody can answer (a
headless run) rather than left waiting.

## Custom commands and rules

- **Commands.** Markdown files in `.prometheus/commands/` become slash commands
  in the composer (see [.prometheus/commands/review.md](../.prometheus/commands/review.md)).
  Prompts advertised by MCP servers join the same list.
- **Rules.** Markdown files in `~/.prometheus/rules/` or
  `.prometheus/rules/`. A rule with `paths:` globs (e.g. `src/web/**`) is only
  injected once the conversation touches a matching file; an unscoped rule
  always applies.

## Desktop app

The window opens on the current directory. Click the workspace chip in the
title bar to switch folders. `PROMETHEUS_PERMISSION_MODE=auto` starts in auto
mode.

Panes in the right-hand workbench:

- **Changes** — per-file diffs for the session or just the last turn.
- **File** — any workspace file with line numbers.
- **Terminal** — a persistent shell in the workspace. It is not a PTY: each
  line is followed by a sentinel that reports the working directory, so `cd` is
  reflected back and the pane knows when a command finished. Interactive
  programs (`vim`, a REPL, a password prompt) cannot be driven from it; use the
  agent's `bash` tool or a real terminal for those. Stop kills the shell and the
  next command starts a fresh one, because Windows cannot deliver `SIGINT` to a
  child of a spawned shell.
- **Artifacts** — previewable files the session produced (markdown, HTML, SVG,
  JSON, CSV).
- **Browser** — an in-app web view for docs and previews. "Use page" drops the
  visible page text into the composer.

Sessions can run in an isolated worktree on a `prometheus/<session>` branch,
then be viewed as a diff, merged back, or discarded without touching your
working copy. The full renderer ↔ host protocol is in
[desktop/README.md](../desktop/README.md).
