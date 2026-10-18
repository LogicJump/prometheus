# Second-round gap analysis and plan

This is the working plan for the second round of parity work against Claude
Code, OpenAI Codex, and Cursor. The first round
([competitive-research.md](competitive-research.md)) closed the gap in
appearance — diffs, checkpoints, a terminal, a settings page. This round's
finding was that **the interface is no longer the gap; behaviour is**.

Most of what follows has since landed. The table is kept as the record of what
was missing and why each item mattered.

## What the three had that we did not

| Capability | Claude Code | Codex | Cursor | Prometheus then |
| --- | --- | --- | --- | --- |
| Protected paths | `.git`/`.vscode`/rc files/`.mcp.json` never auto-approved; `rm` of a root bypasses allow rules | same | same | **none** |
| Layered instructions | managed → user → project → subdirectory on demand; `.claude/rules/*.md` with `paths:` globs | `AGENTS.md` per directory + overrides | `.cursor/rules/*.mdc`, four scopes | nearest file only, max 6 levels, no glob rules |
| Hooks | 30+ events, exit code 2 blocks, can rewrite tool input | 11 events, trust recorded per hook hash | 20+ events | 5 events, `UserPromptSubmit` declared but never dispatched |
| Re-injection after compaction | root memory, rules, plan, recent files re-injected | similar | similar | system prompt only |
| MCP | tools + resources + prompts + deferred schemas | tools + OAuth + per-tool approval | tools + prompts + resources + elicitation | tools only, full schema resident |
| Headless output | `-p --output-format json/stream-json`, `--json-schema` | `exec --json`, `--output-schema` | `-p --output-format` | terminal text only |
| Cost | `/cost` split by model, cache-hit billing | by model/reasoning/speed | router tiers + spend cap | token counts, **no money** |
| Session state | working / blocked / done / failed | same | same | notifications, no sidebar state |
| Background sub-agents | background by default, pinnable | `/subagents`, steerable | foreground/background | foreground parallel only |

**Something none of the three had:** rewinding code *and* conversation together
to turn N. Cursor restores files only; Codex restores conversation only.
Prometheus already has `rewindTo`, which restores both — that is a point worth
making plainly.

## What the round covered

### A. Safety floor (protected paths and critical-path fuses)

- `PROTECTED_PATHS` in `src/permissions.ts`: `.git/`, `.vscode/`, `.idea/`,
  `.mcp.json`, `.prometheus/`, shell startup files. Writing to one of these
  asks in every mode, `auto` included.
- Critical-path fuse: `rm`/`rmdir` aimed at the workspace root, the home
  directory, or a drive root bypasses every allow rule and every saved approval
  and is refused with a reason.
- The audit log records which rule fired.

### B. Hook semantics

- Exit code 2 blocks (unchanged), but `PreToolUse` stdout becomes the
  model-visible reason; other non-zero codes only report.
- New events: `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`.
- `UserPromptSubmit` is actually dispatched, and non-empty stdout replaces the
  user's input.
- `PreToolUse` may rewrite tool input through a JSON `{"input": {...}}` on
  stdout.

### C. Layered context

- `src/instructions.ts` reads `~/.prometheus/rules/*.md` and
  `<workspace>/.prometheus/rules/*.md`; frontmatter `paths: ["src/**"]` injects
  a rule only once the conversation touches a matching file.
- Instruction files load from the workspace root down to the cwd (capped at 6
  levels) instead of only the nearest one, with `@path` imports up to 4 deep.
- After compaction: system prompt, scoped rules, the current todo plan, and the
  paths of the five most recently edited files are re-injected.

### D. MCP extensions

- Client gains `resources/list`, `resources/read`, `prompts/list`, `prompts/get`.
- MCP prompts become slash commands; resources are reachable through
  `mcp_read_resource`.
- Deferred tool schemas: MCP tools advertise a name and one line until
  `tool_search` asks for the full schema.

### E. Headless and cost

- `--output-format text|json|stream-json`, `--output-schema <file>`,
  `--max-budget-usd <n>`.
- `src/pricing.ts` matches model ids by prefix; `usage.ts` records cost; `/cost`
  and the settings page show money, not just tokens.

### F. Session state and background sub-agents

- Sessions record `status` (ready / working / needs-input / error); the sidebar
  shows a dot tied to the notification.
- `delegate` accepts `background: true`; the sub-agent writes its report back
  into the session without blocking the main loop.

## Order and acceptance

1. A → B (safety and hooks: independent, testable)
2. C (context: touches the prompt, needs a real model to verify)
3. D → E (extension and headless)
4. F (state and background)

Each stage ends with `npx tsc --noEmit` clean, `node --test "tests/*.test.ts"`
green, and a screenshot confirming the UI change. A packaged build runs once at
the end.

## Explicitly out of scope

Cloud execution, remote control, a plugin marketplace, LSP diagnostics, tab
completion, Cmd-K inline editing, and multi-repository workspaces. Each either
depends on hosted infrastructure or belongs to the IDE form factor rather than a
general-purpose agent.
