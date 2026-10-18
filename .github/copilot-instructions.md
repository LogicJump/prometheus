Based on the Contributing guide in CONTRIBUTING.md.

## What this repo is

- A Node 22.6+ TypeScript project that runs **without a build step** — Node
  strips the types itself. Do not add a bundler, a transpiler, or a runtime
  dependency without a strong reason; the zero-dependency property is a feature.
- The desktop app is Electron. `desktop/main.js` spawns `desktop/host.js` per
  window and speaks NDJSON over stdio.
- The renderer is plain ES modules. No framework, no build step.
- The embedded workbench lives under `src/embedded/`; the pack installer under
  `src/packs/`.

## Before you finish a change

```bash
npx tsc --noEmit
node --test "tests/*.test.ts"
```

Both must be clean. Tests run offline against a fake model server and never
spend tokens.

## Style

- Comments explain **why**, not what. If a line needs a comment to say what it
  does, rename something instead.
- Match the surrounding code's naming, density, and idiom.
- A test that only exercises the happy path is not a test of a guard.
- Do not reformat files you are not otherwise changing.

## Commits

- Subject in the imperative, describing the change's effect.
- One logical change per commit.
- If you fixed a bug, say what was actually broken, not what you changed.
