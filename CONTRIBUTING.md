# Contributing

## Development

```bash
npm install
npm test          # node --test, offline, uses a fake model server
npm run typecheck
npm run desktop   # Electron window
```

There is no build step for the runtime: Node 22.6+ strips the TypeScript types
directly. Keep it that way — a dependency that a bundler would need is a
dependency a user has to trust.

## Adding a doc

Documents under `docs/` describe decisions, not code. If a fact changes, change
the document in the same commit; a document that disagrees with the code is
worse than no document.

## Adding a tool

New agent tools go through `src/tools/pipeline.ts` (resolve → guard → prepare →
execute → settle). Give every tool a description the model can act on, refuse
paths outside the workspace, and surface failures as text the model can read
rather than as a thrown error. Add a test that exercises the guard, not just the
happy path.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in [LICENSE](LICENSE).
