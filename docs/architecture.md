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
| trim | over 75% of the window | drop the oldest complete turns, keep 24 recent |
| summarize | still over after trimming | recap of requests/files/commands + 8 recent messages |
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

## Wiring — `src/agent.ts` and `desktop/host.js`

`Agent` owns the conversation, tools, permissions, hooks, sub-agents, and the
translation of loop events into UI calls. `onQueryEvent` lets the desktop host
mirror events without owning the UI. `desktop/host.js` maps the same `Agent`
onto the newline-JSON protocol documented in `desktop/README.md`.
