/** Workspace index: symbol extraction, ranking, skip rules, and staleness. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIndex, extractSymbols, formatSearch, searchIndex, tokenize } from "../src/codeIndex.ts";

function workspace(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-index-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("declarations are extracted across languages", () => {
  const ts = extractSymbols([
    "export async function loadUser(id: string) {",
    "export class SessionStore {}",
    "export interface SessionMeta {}",
    "const cache = new Map();",
  ].join("\n"));
  assert.deepEqual(ts.map((symbol) => `${symbol.kind}:${symbol.name}`), [
    "function:loadUser",
    "class:SessionStore",
    "type:SessionMeta",
    "const:cache",
  ]);

  assert.equal(extractSymbols("def parse_args(argv):")[0].name, "parse_args");
  assert.equal(extractSymbols("func NewServer(cfg Config) {")[0].name, "NewServer");
  assert.equal(extractSymbols("pub fn render(&self) {}")[0].name, "render");
});

test("the index ranks by declared symbols first, then path and text", () => {
  const dir = workspace({
    "src/compaction.ts": "export function compactContext() {}\n",
    "src/http.ts": "export function request() {}\n",
    "docs/notes.md": "compaction notes\n",
  });
  try {
    const index = buildIndex(dir);
    const hits = searchIndex(index, "compactContext", 5);
    assert.equal(hits[0].path, "src/compaction.ts");
    assert.ok(hits[0].score > (hits[1]?.score ?? 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build directories and dot-directories are skipped", () => {
  const dir = workspace({
    "src/app.ts": "export function main() {}\n",
    "node_modules/pkg/index.ts": "export function dep() {}\n",
    ".research/notes.ts": "export function scraped() {}\n",
    "release/out.ts": "export function built() {}\n",
    "dist/bundle.ts": "export function bundled() {}\n",
  });
  try {
    const paths = buildIndex(dir).files.map((file) => file.path);
    assert.deepEqual(paths, ["src/app.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty or stop-word queries return nothing", () => {
  const index = buildIndex(workspace({ "a.ts": "export function find() {}\n" }));
  assert.deepEqual(searchIndex(index, ""), []);
  assert.deepEqual(searchIndex(index, "the and for"), []);
});

test("formatting names files, symbols, and the reason for the match", () => {
  const dir = workspace({ "src/auth.ts": "export function refreshToken() {}\n" });
  try {
    const hits = searchIndex(buildIndex(dir), "refreshToken", 3);
    const text = formatSearch(hits, "refreshToken");
    assert.match(text, /src\/auth\.ts/);
    assert.match(text, /refreshToken \(function, L1\)/);
    assert.match(text, /why:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tokenize drops stop words and short identifiers", () => {
  const tokens = tokenize("export const sessionStore = createSessionStore();");
  assert.ok(tokens.has("sessionstore") || tokens.has("sessions"));
  assert.ok(!tokens.has("const"));
});
