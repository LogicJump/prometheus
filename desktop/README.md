# Prometheus Desktop

The Electron app wraps the same agent runtime the CLI uses. The window never
talks to the model directly: it spawns `desktop/host.js` under plain Node,
speaks newline-delimited JSON over stdio, and renders the event stream.

```
desktop/main.js        Electron main process: window, IPC, host process lifecycle
desktop/host.js        Agent host: owns one Agent, handles commands, emits events
desktop/terminal.js    Persistent shell behind the terminal pane
desktop/git.js         Git status and commits for the Changes pane
desktop/preload.cjs    The renderer's only bridge to the main process
desktop/renderer/      UI: index.html, app.js, styles.css (no framework, no build)
```

## Run

```bash
npm run desktop
```

The window opens on the current directory. Click the workspace chip in the title
bar to switch folders. `PROMETHEUS_PERMISSION_MODE=auto` starts in auto mode.

## Package

```bash
npm install -D electron-builder
npm run build
```

Artifacts land in `release/`: an NSIS installer plus a portable `.exe` on
Windows, a `.dmg` on macOS, and AppImage/deb on Linux.

## Protocol

Renderer -> host (`cmd`):

| Command | Payload | Effect |
| --- | --- | --- |
| `init` | `cwd`, `mode` | Start a session in a workspace |
| `prompt` | `text` | Run a turn |
| `abort` | - | Interrupt the running turn |
| `permission` | `id`, `answer` | Answer a pending confirmation |
| `setMode` | `mode` | Switch ask / auto / plan |
| `setModel` | `model` | Switch model (allowlist enforced) |
| `newSession` | - | Start a fresh conversation |
| `loadSession` | `id` | Restore a saved session |
| `listSessions` | - | Refresh the drawer |
| `setCwd` | `cwd` | Change workspace |
| `compact` | - | Force context compaction |
| `getChanges` | - | Re-emit the session's file changes |
| `getTree` | `path` | List one directory level |
| `getFile` | `path` | Read a file preview |
| `searchFiles` | `query` | Rank workspace paths for `@` completion |
| `getCheckpoints` / `restoreCheckpoint` | `id` | List or restore file snapshots |
| `clearCheckpoints` | - | Drop the session's snapshots |
| `initProject` | - | Run the agent to write `PROMETHEUS.md` |
| `clearHistory` | - | Drop the conversation, keep the session |
| `gitStatus` | - | Branch, sync counts, changed files |
| `gitCommit` | `message`, `paths` | Stage and commit |
| `terminalOpen` | - | Start the shell and replay scrollback |
| `terminalRun` | `command` | Run one command line |
| `terminalInterrupt` / `terminalRestart` / `terminalClose` | - | Control the shell |
| `getSettings` / `saveSettings` | `settings` | Read or write configuration |

Host -> renderer (`type`): `hello`, `ready`, `state`, `models`, `changes`,
`checkpoints`, `tree`, `file`, `file_matches`, `settings`, `settings_saved`,
`session_loaded`, `session_saved`, `sessions`, `run_start`, `queued`,
`user_queued_delivered`, `assistant_start`, `assistant_delta`, `assistant_end`,
`thinking_start`, `thinking_end`, `tool_start`, `tool_end`, `tool_output`,
`todos`, `permission_request`, `notice`, `error`, `run_end`, `git_status`,
`git_commit`, `terminal_output`, `terminal_state`, `fatal`, `host_exit`.

## Design notes

- The host is a separate process so the TypeScript sources run natively under
  Node (no bundler) and a runaway tool cannot freeze the window.
- Permissions surface as an inline bar above the composer, not a modal, so the
  transcript stays readable while deciding.
- Tool rows are quiet one-liners; full output is one click away on demand.
- Markdown is rendered by a small local renderer; nothing is loaded from the
  network, and the renderer runs under a strict CSP.

## Layout

The renderer is plain ES modules with no build step:

```
renderer/app.js       state, host events, panes, palette, comments
renderer/markdown.js  the markdown renderer shared by transcript and previews
renderer/i18n.js      en / zh dictionaries
renderer/styles.css   theme, layout, panes
```

The browser pane is a native `WebContentsView` owned by the main process
(`desktop/browser.js`); the renderer only reports its rectangle and drives
navigation. Screenshots taken with `win.webContents.capturePage()` do not
include that view — use an OS-level screenshot when verifying it.
