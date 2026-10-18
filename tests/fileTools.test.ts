/** The edit matching ladder, atomic batches, patches, and their results. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editFileTool } from "../src/tools/fileTools.ts";
import { findMatch, parsePatch, reindent } from "../src/tools/match.ts";

function workspace(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-edit-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

function ctxFor(dir: string) {
  return {
    cwd: dir,
    signal: new AbortController().signal,
    config: { allowedDirs: [] },
    permissions: { mode: "auto", check: async () => ({ allowed: true }) },
    ui: {},
    todo: { items: [] },
    runSubagent: async () => "",
  } as never;
}

async function edit(dir: string, input: Record<string, unknown>) {
  return editFileTool.execute(input, ctxFor(dir));
}

test("exact matches still work and report the rung", async () => {
  const dir = workspace({ "a.ts": "const x = 1;\nconst y = 2;\n" });
  const result = await edit(dir, { path: "a.ts", old_string: "const y = 2;", new_string: "const y = 3;" });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /\+1 -1/);
  assert.doesNotMatch(result.content, /tolerant/);
  assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "const x = 1;\nconst y = 3;\n");
});

test("trailing whitespace differences still match", () => {
  const text = "a\n  b   \nc\n";
  const found = findMatch(text, "a\n  b\nc");
  assert.ok(found.ok);
  assert.equal(found.match.rung, "whitespace");
});

test("CRLF files match LF search text", async () => {
  const dir = workspace({ "crlf.txt": "one\r\ntwo\r\nthree\r\n" });
  const result = await edit(dir, { path: "crlf.txt", old_string: "two\n", new_string: "TWO\n" });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /whitespace/);
  assert.match(readFileSync(join(dir, "crlf.txt"), "utf8"), /TWO/);
});

test("indentation differences match and the replacement is re-indented", async () => {
  const dir = workspace({ "nested.ts": "function f() {\n    const a = 1;\n    return a;\n}\n" });
  const result = await edit(dir, {
    path: "nested.ts",
    old_string: "const a = 1;\nreturn a;",
    new_string: "const a = 2;\nreturn a * 2;",
  });
  assert.ok(!result.isError, result.content);
  assert.match(result.content, /indent/);
  const text = readFileSync(join(dir, "nested.ts"), "utf8");
  assert.match(text, /^ {4}const a = 2;$/m);
  assert.match(text, /^ {4}return a \* 2;$/m);
});

test("an ambiguous search refuses and names the candidate lines", async () => {
  const dir = workspace({ "a.txt": "alpha\nbeta\nbeta\n" });
  const result = await edit(dir, { path: "a.txt", old_string: "beta", new_string: "gamma" });
  assert.equal(result.isError, true);
  assert.match(result.content, /ambiguous/);
  assert.match(result.content, /2, 3/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha\nbeta\nbeta\n");
});

test("a batch applies every edit atomically", async () => {
  const dir = workspace({ "b.ts": "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n" });
  const result = await edit(dir, {
    path: "b.ts",
    edits: [
      { old_string: "export const A = 1;", new_string: "export const A = 10;" },
      { old_string: "export const C = 3;", new_string: "export const C = 30;" },
    ],
  });
  assert.ok(!result.isError, result.content);
  const text = readFileSync(join(dir, "b.ts"), "utf8");
  assert.match(text, /A = 10/);
  assert.match(text, /C = 30/);
});

test("one failing edit aborts the whole batch without writing", async () => {
  const dir = workspace({ "c.ts": "one\ntwo\n" });
  const result = await edit(dir, {
    path: "c.ts",
    edits: [
      { old_string: "one", new_string: "ONE" },
      { old_string: "missing text", new_string: "x" },
    ],
  });
  assert.equal(result.isError, true);
  assert.match(result.content, /edit 2/);
  assert.equal(readFileSync(join(dir, "c.ts"), "utf8"), "one\ntwo\n");
});

test("SEARCH/REPLACE patches apply in order", async () => {
  const dir = workspace({ "d.ts": "const first = 1;\nconst second = 2;\n" });
  const patch = [
    "<<<<<<< SEARCH",
    "const first = 1;",
    "=======",
    "const first = 100;",
    ">>>>>>> REPLACE",
    "",
    "<<<<<<< SEARCH",
    "const second = 2;",
    "=======",
    "const second = 200;",
    ">>>>>>> REPLACE",
  ].join("\n");
  assert.equal(parsePatch(patch).length, 2);
  const result = await edit(dir, { path: "d.ts", patch });
  assert.ok(!result.isError, result.content);
  const text = readFileSync(join(dir, "d.ts"), "utf8");
  assert.match(text, /first = 100/);
  assert.match(text, /second = 200/);
});

test("reindent keeps the file's indentation for a trimmed replacement", () => {
  const matched = "    if (x) {\n        return 1;\n    }";
  const old = "if (x) {\n    return 1;\n}";
  const updated = reindent(matched, old, "if (y) {\n    return 2;\n}");
  assert.equal(updated, "    if (y) {\n        return 2;\n    }");
});

test("an unknown shape explains what to provide", async () => {
  const dir = workspace({ "e.ts": "x\n" });
  const result = await edit(dir, { path: "e.ts" });
  assert.equal(result.isError, true);
  assert.match(result.content, /old_string \+ new_string|edits|patch/);
});
