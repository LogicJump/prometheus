
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/LogicJump/prometheus">
    <img src="build/icon.svg" alt="Logo" width="120" height="120">
  </a>

  <h3 align="center">Prometheus</h3>

  <p align="center">
    An open-source coding agent designed for embedded and firmware development.
    <br />
    Build, flash, debug, and inspect MCUs directly from AI-powered sessions.
    <br />
    <br />
    <a href="#quick-start"><strong>Get Started »</strong></a>
    ·
    <a href="docs/embedded-workbench-design.md">Embedded Workbench</a>
    ·
    <a href="docs/architecture.md">Architecture</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#why-prometheus">Why Prometheus</a></li>
    <li><a href="#features">Features</a></li>
    <li><a href="#quick-start">Quick Start</a></li>
    <li><a href="#embedded-workbench">Embedded Workbench</a></li>
    <li><a href="#architecture">Architecture</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#documentation">Documentation</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

## Why Prometheus

Most coding agents treat the repository as the entire world. Firmware doesn't
work that way. The answer to "why won't UART2 transmit?" lives in a register
bit, a linker script, a vendor SVD file, or the bytes coming back on `COM7`.
Prometheus puts those behind tools the model can call, so it can close the
loop — edit, build, flash, read the port, diagnose, fix — without a human
copy-pasting output between windows.

It is also a complete, general-purpose coding agent for ordinary software work:
streaming chat, resilient file edits, a command sandbox, sessions, rewinding,
sub-agents, MCP, hooks, and a desktop app with diffs, checkpoints, a terminal,
and worktrees.

## Features

Core agent:

- **Streaming chat with tool calling** — the model reads, edits, searches, and
  runs commands in a loop until the task is done.
- **Three permission modes** — `ask` confirms each mutating tool, `auto` runs
  them but prompts for risky shell commands, `plan` is read-only.
- **Command sandbox** — allow / confirm / deny classification, workspace path
  confinement, secret scrubbing, optional network cutoff.
- **Resilient edits** — `edit_file` tolerates CRLF, trailing whitespace,
  indentation drift, and supports SEARCH/REPLACE patches.
- **Rewind** — restore code *and* conversation to any earlier turn.
- **Progressive compaction** — trim, summarize, then clip. Keeps long sessions
  inside the context window without extra model calls.
- **Sub-agents** — run self-contained tasks in fresh contexts; up to four in
  parallel.
- **Sessions** — append-only JSONL transcripts, resumable with `-r <id>`.

Embedded tools:

| Tool | Purpose |
| --- | --- |
| `embed_project` | Detect build system, MCU, and target from the tree |
| `embed_build` | Build via CMake, Make, Zephyr, ESP-IDF, PlatformIO, or Cargo; parse diagnostics |
| `embed_flash` | Detect probe and target, refuse ambiguous flashes, then flash |
| `embed_serial` | Capture a port with line tagging and bounded buffering |
| `embed_debug` | Drive GDB over MI: breakpoints, stepping, backtraces, locals |
| `embed_registers` | Look up registers and fields from vendor SVD files |
| `embed_analyze` | Static analysis, memory maps, stack usage |
| `embed_probe` | Enumerate debug probes and match them to targets |
| `embed_diagnose` | Correlate build output, serial logs, and register state |

Desktop app:

- **Diff-first review** — per-file changes, inline comments, send feedback to
  the agent.
- **Checkpoints** — restore individual file writes or the whole session.
- **Persistent terminal** — a shell that stays open in the workspace.
- **Artifacts and browser panes** — preview generated files; drop page text into
  the composer.
- **Worktrees** — run sessions on isolated branches, then merge or discard.
- **Goal and loop modes** — autonomous rounds with hard ceilings and progress
  guards. See [`src/autoloop.ts`](src/autoloop.ts).
- **Command palette** — `Ctrl+K` lists every action and custom command.

Extensibility:

- **MCP** — stdio and Streamable HTTP servers, user and project scopes.
- **Hooks** — shell commands around tool use, with blocking and input rewriting.
- **Custom commands** — Markdown files under `.prometheus/commands/`.
- **Rules** — path-scoped Markdown injected only when relevant.
- **Memory** — durable user and project facts via the `remember` tool.

## Quick Start

```bash
git clone https://github.com/LogicJump/prometheus.git
cd prometheus
npm install
npm link          # optional: puts `prometheus` on PATH
```

Configure an endpoint in `~/.prometheus/config.json`:

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o"
}
```

Run it:

```bash
prometheus                                    # interactive REPL
prometheus "add input validation to src/x.ts" # one-shot
npm run desktop                               # desktop app
```

> **Windows 10/11** is the supported platform for the desktop app and the
> embedded workbench. The CLI runs anywhere Node 22.6+ runs.

## Embedded Workbench

Toolchains are discovered, not bundled. Search order:

1. `PROMETHEUS_TOOLCHAINS` environment variable
2. Installed offline packs
3. Platform install roots (e.g. CubeProgrammer, ESP-IDF)
4. `PATH`

A pack is one directory under `%LOCALAPPDATA%\Prometheus\toolchains`, containing
`pack.json` and its payload. Remove the directory and it's gone — no registry, no
residue. See [docs/toolchain-packs.md](docs/toolchain-packs.md) for the isolation
contract and install transaction.

Common workflows:

```
> build the firmware and flash it to the board
> the LED isn't blinking — capture serial for 5 seconds
> what's the reset value of USART2->CR1?
> why did the build fail?
```

## Architecture

```
bin/prometheus.js    entry point, CLI parsing
src/query.ts         the async-generator loop: compact → request → stream → tools
src/agent.ts         tool dispatch, permissions, sub-agents
src/llm.ts           OpenAI-compatible streaming client
src/providers.ts     declarative provider registry
src/context.ts       progressive compaction
src/permissions.ts   modes, approvals, path confinement, audit log
src/sandbox.ts       command classification, env scrubbing
src/embedded/        toolchain detection, build, flash, serial, debug, SVD
src/packs/           catalog, verified download, transactional install
src/autoloop.ts      goal and task-loop driver
src/tools/           tool implementations
desktop/             Electron app: main, host, renderer
```

No runtime dependencies. Node's built-in TypeScript stripping means there is no
build step for the runtime.

## Roadmap

- [x] Core agent loop, tools, permissions, sessions
- [x] Desktop app with diffs, checkpoints, terminal, worktrees
- [x] Embedded workbench (build, flash, serial, GDB/MI, SVD)
- [x] Offline toolchain packs with verified transactional install
- [x] Goal and loop autonomous modes
- [ ] More MCU families in the pack catalog
- [ ] LSP integration for in-editor diagnostics
- [ ] Remote execution

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/reference.md](docs/reference.md) | Configuration, CLI flags, hooks, MCP, panes |
| [docs/architecture.md](docs/architecture.md) | Layer boundaries and data flow |
| [docs/toolchain-packs.md](docs/toolchain-packs.md) | The isolation contract and the install transaction |
| [docs/embedded-workbench-design.md](docs/embedded-workbench-design.md) | Why the embedded tools exist and how they fit together |
| [docs/embedded-tool-interfaces.md](docs/embedded-tool-interfaces.md) | Each `embed_*` tool's inputs, outputs, and failure modes |
| [docs/embedded-toolchain-packaging.md](docs/embedded-toolchain-packaging.md) | How the vendored packs are built and verified |
| [docs/embedded-knowledge-formats.md](docs/embedded-knowledge-formats.md) | SVD, linker maps, and diagnostic formats |
| [docs/embedded-bench-automation.md](docs/embedded-bench-automation.md) | Bench and HIL automation notes |
| [docs/competitive-research.md](docs/competitive-research.md) | Where the product sits against Codex, Claude Code, and Cursor |
| [desktop/README.md](desktop/README.md) | The renderer ↔ host protocol |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test          # 230 tests, offline, no tokens spent
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/LogicJump/prometheus.svg?style=for-the-badge
[contributors-url]: https://github.com/LogicJump/prometheus/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/LogicJump/prometheus.svg?style=for-the-badge
[forks-url]: https://github.com/LogicJump/prometheus/network/members
[stars-shield]: https://img.shields.io/github/stars/LogicJump/prometheus.svg?style=for-the-badge
[stars-url]: https://github.com/LogicJump/prometheus/stargazers
[issues-shield]: https://img.shields.io/github/issues/LogicJump/prometheus.svg?style=for-the-badge
[issues-url]: https://github.com/LogicJump/prometheus/issues
[license-shield]: https://img.shields.io/github/license/LogicJump/prometheus.svg?style=for-the-badge
[license-url]: https://github.com/LogicJump/prometheus/blob/master/LICENSE
