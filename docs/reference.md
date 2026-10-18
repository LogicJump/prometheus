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
| `sessions/<id>/` | Conversation transcripts |
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
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` |
| `--output-schema <file>` | Check the final answer against a JSON Schema |
| `--max-budget-usd <n>` | Stop between turns once the run has spent this much |
| `--max-tokens <n>` | Per-response cap (default 16000) |
| `--context-window <n>` | Compaction threshold (default 1,000,000) |
| `--max-turns <n>` | Tool-loop cap per message (default 60) |

### REPL commands

`/help`, `/model [name]`, `/mode [ask|auto|plan]`, `/plan`, `/yolo`, `/clear`,
`/compact`, `/cost`, `/context`, `/sessions`, `/resume <id>`, `/memory`,
`/init`, `/exit`. End a line with `\` to continue it. Esc interrupts a running
turn.

### Headless

For scripts and CI, `--output-format` swaps the terminal renderer for one that
emits objects. `stream-json` prints one JSON line per event as it happens.

```bash
prometheus --output-format json "summarise the changes on this branch" | jq -r .text
prometheus --output-format stream-json --mode auto "run the tests and fix what fails"
prometheus --max-budget-usd 0.50 "refactor src/context.ts"
```

`--output-schema` checks the final answer against a JSON Schema and reports
`schemaValid` rather than failing the run. In headless mode a tool that would
prompt is refused with a readable reason instead of blocking on a terminal that
is not there.

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
`allowedDirs` from config). Shell commands are classified by `src/sandbox.ts`:
destructive commands are denied, risky ones raise a confirmation, and the rest
run. Permission choices can be saved as persistent rules.

Two rules sit above every saved approval:

- **Protected paths** — `.git`, `.vscode`, `.idea`, `.prometheus`, `.mcp.json`,
  and shell profiles ask in every mode, including `auto`, because editing them
  changes how the agent itself runs.
- **Critical commands** — deleting the workspace root, the home directory, or a
  drive root are refused outright; no saved approval can authorise them.

## Hooks

`~/.prometheus/hooks.json` or `<workspace>/.prometheus/hooks.json` runs local
commands around agent activity. Each hook receives a JSON payload on stdin; a
failing `PreToolUse` hook blocks the tool and its output is returned to the
model as the reason.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "^bash$", "command": "./scripts/guard.sh" }],
    "PostToolUse": [{ "command": "npm run lint --silent" }],
    "Stop": [{ "command": "echo turn finished" }]
  }
}
```

## MCP servers

Stdio and Streamable HTTP servers listed in `~/.prometheus/mcp.json` (user
scope) or `<workspace>/.prometheus/mcp.json` (project scope, overrides by name)
contribute their tools to the agent:

```json
{
  "servers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

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
- **Terminal** — a persistent shell in the workspace.
- **Artifacts** — previewable files the session produced (markdown, HTML, SVG,
  JSON, CSV).
- **Browser** — an in-app web view for docs and previews. "Use page" drops the
  visible page text into the composer.

Sessions can run in an isolated worktree on a `prometheus/<session>` branch,
then be viewed as a diff, merged back, or discarded without touching your
working copy. The full renderer ↔ host protocol is in
[desktop/README.md](../desktop/README.md).
