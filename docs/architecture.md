# Architecture

Prometheus is six layers plus a thin wiring layer. Each layer has one job and
one direction of dependency; nothing lower knows about anything higher.

```
desktop/main.js ── desktop/host.js ── src/agent.ts ── src/query.ts
     (Electron)        (protocol)        (session)       (state machine)
                                                            │
                          ┌─────────────────────────────────┼──────────────────┐
                          │                │                │                  │
                    src/errors.ts    src/context.ts   src/tools/pipeline.ts  src/mcp.ts
                          │                │                │                  │
                          └────────────────┴────────────────┴──────────────────┘
                                            src/sessions.ts
```

## 1. Main loop — `src/query.ts`

One async generator. The caller pulls events; the loop never calls a UI.

```
idle → compact → requesting → streaming → tools → (requesting | idle)
                     ^                          │
                     └──── retrying <───────────┘   recoverable errors only
```

- `messages` is mutated in place, so a caller holding a reference to the
  conversation keeps seeing the truth even after compaction rewrites it.
- A tool message is never separated from the assistant turn that requested it.
  Queued user text joins only at a tool boundary.
- The generator's return value is `{ usage, reason }` with reason
  `complete | aborted | max_turns | error`.

Streaming deltas reach the caller live: `ChatClient.chat` pushes into a
single-consumer `Channel` that the generator drains while the request is in
flight, so the UI sees tokens as they arrive rather than in one burst.

## 2. Errors — `src/errors.ts`

Every failure is classified once:

| Level | Examples | Handling |
| --- | --- | --- |
| recoverable | 429, 5xx, `ECONNRESET`, `ETIMEDOUT`, request timeout | keep the conversation, back off (`800ms × 2^(n-1)`, capped at 15s), retry |
| terminal | 401, 403, 400, `AbortError` | end the turn and report |

Tool errors are neither: they are returned to the model as tool output, which
is how the loop normally continues.

## 3. Model access — `src/providers.ts`

One wire protocol (OpenAI-compatible chat completions), one adapter
(`src/llm.ts`), and a registry of providers described as data:

```ts
{ id, label, baseUrl, apiKeyEnv, models?, contextLength?, supportsReasoningEffort? }
```

- Built-ins: OpenAI, DeepSeek, Moonshot, Qwen, Ollama, OpenRouter.
- Custom gateways: add to `~/.prometheus/providers.json`, or set `baseUrl`
  directly (which always wins).
- Deliberately absent: protocol fallback chains (no Anthropic/Responses
  translation) and OAuth. A provider that does not speak the OpenAI shape is
  out of scope.

## 4. Context — `src/context.ts`

Three progressive levels, all local (no summarization model call):

| Level | Trigger | Effect |
| --- | --- | --- |
| trim | over 75% of the window | drop the oldest complete turns, keep 24 recent (local, free) |
| summarize | still over after trimming | the session model writes a structured recap; falls back to a local recap if the call fails |
| aggressive | the recent window itself overflows | 4 recent messages, tool payloads clipped to 4k characters |

Split points always snap to a user message so a tool result never loses its
assistant turn.

## 5. Tools — `src/tools/pipeline.ts`

Every call walks five stages:

| Stage | Owner | Stops the call when |
| --- | --- | --- |
| resolve | pipeline | unknown tool, malformed JSON |
| guard | permissions + PreToolUse hooks | denied, or a hook exits non-zero |
| prepare | checkpoints, change baseline | never (failures are swallowed) |
| execute | the tool | the tool throws or returns `isError` |
| settle | PostToolUse hooks, UI | never (output only) |

Tools therefore never think about permissions or checkpointing; the loop never
re-implements ordering. Sub-agents run the pipeline with `trusted: true`.

## 6. MCP — `src/mcp.ts`

- Transports: `stdio` (default, `command` + `args`) and Streamable HTTP (`url`,
  POST + JSON or SSE response, `Mcp-Session-Id` honored).
- Scopes: `~/.prometheus/mcp.json` (user) and `<workspace>/.prometheus/mcp.json`
  (project); a project server overrides a user server with the same name.
- Tools are exposed as `mcp__<server>__<tool>`, prompt in ask mode, and are
  unavailable in plan mode.
- No OAuth: credentials are env vars or headers in the config file.

## 7. Sessions — `src/sessions.ts`

`~/.prometheus/sessions/<id>/`:

```
meta.json              flags, timestamps, model, generation, messageCount, lastHash
messages.0001.jsonl    one JSON message per line
messages.0002.jsonl    a new generation after compaction rewrote the history
```

- Appends write only new records. The newest generation is a full snapshot of
  the conversation; earlier generations are audit history.
- A crash mid-write can lose at most the last partial line; it is skipped on
  read.
- Legacy single-file `<id>.json` sessions are read transparently and migrate to
  the directory layout on first write.

## Sandbox — `src/sandbox.ts`

A policy layer, not an OS sandbox (the settings UI says so):

- **Classification**: deny (disk formatting, fork bombs, power off, piping a
  download into an interpreter) / confirm (recursive deletes, history rewrites,
  package installs, privilege escalation) / allow. `auto` mode consults it;
  `ask` still prompts for every mutating tool.
- **Path confinement**: absolute paths and parent escapes outside the workspace
  are refused with the offending path named.
- **Environment scrub**: commands get a minimal env; API keys and unrelated
  secrets are not inherited.
- **Network policy**: `off` rejects known fetchers and injects a dead proxy.

## Rewind — checkpoints keyed by message

`captureBefore` records `messageIndex`, so `restoreAfterMessage` can undo every
file change made at or after a message. The host's `rewindTo` truncates the
conversation, restores files, persists (a shorter conversation starts a new JSONL
generation), and re-renders the transcript. The transcript offers the action on
user turns.

## Persistent approval rules — `src/rules.ts`

A permission choice can be remembered as a rule instead of a one-off. Rules are
globs over `tool:detail` (`bash:git status*`, `write_file:src/**`), stored in
`~/.prometheus/rules.json` (user scope) or `.prometheus/rules.json` (project
scope). Evaluation is first-match-wins and happens before any prompt, so an
allow rule runs silently and a deny rule refuses with its reason. Project rules
only apply inside their own workspace; user rules apply everywhere.

## Parallel sub-agents — `delegate`

`delegate` accepts either `prompt` (one child) or `prompts` (up to four,
`Promise.all`). Each child gets its own conversation, its own abort controller
(one child failing does not cancel the others), and a read-mostly tool set.
Results come back as labelled sections so the parent can merge them in one turn.

## Workspace index — `src/codeIndex.ts`

`search_codebase` ranks files before the agent starts grepping. The index
extracts declarations (functions, classes, types, consts, plus Python/Go/Rust
shapes) and keeps a token-frequency map per file; queries score path matches,
symbol-name matches, and token overlap. It is a JSON file per workspace under
`~/.prometheus/index/`, built on first search, sampled for staleness (40 files),
and rebuilt when any sample changed. Deliberately not an embedding index: no
daemon, no dependency, bounded to 4000 files and 400 KB per file.

## Model fallback — `src/fallback.ts`

`fallbackModels` in settings wraps the primary client. `shouldFallBack` decides
per failure whether another model plausibly helps: 404 / 429 / 503 / 529, a 400
that names the model, and connection errors. Auth and malformed-request
failures never fall back — the next model would fail the same way. Fallbacks are
per request and reuse the primary's endpoint and key with `reasoningEffort:
auto`, so a model that rejects a concrete effort is not double-punished.

## Compaction visibility

`query()` emits `compacted` with `level` (`trim`, `summarize`, `aggressive`,
`local-fallback`) and the kept message count. The desktop transcript draws a
marker at that point in the conversation, so a shortened context is visible
rather than silent.

## Wiring — `src/agent.ts` and `desktop/host.js`

`Agent` owns the conversation, tools, permissions, hooks, sub-agents, and the
translation of loop events into UI calls. `onQueryEvent` lets the desktop host
mirror events without owning the UI. `desktop/host.js` maps the same `Agent`
onto the newline-JSON protocol documented in `desktop/README.md`.
