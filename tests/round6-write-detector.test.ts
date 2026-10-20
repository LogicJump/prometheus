/**
 * The shell write detector decides the kernel sandbox's mount.
 *
 * `canWriteFiles` answers "may this command write to the workspace", and the
 * answer is used for two things: whether the WSL kernel sandbox binds the
 * workspace read-write or read-only, and whether a git snapshot is taken so
 * the change can be undone. A false negative silently downgrades a read-only
 * mount to... nothing at all — the command simply fails, or on a machine
 * without WSL, runs against a writable tree it was supposed to be kept out of.
 *
 * The list was missing most of the filesystem verbs (`touch`, `mkdir`,
 * `chmod`, `ln`, `tee`, `tar`, `patch`) and every interpreter but three. It
 * also ignored a pipe, so `cat x | tee out` looked read-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { canWriteFiles, MUTATING_PROGRAMS } = await import("../src/tools/shellTools.ts");

const WRITERS = [
  "touch out.txt",
  "mkdir -p build",
  "chmod +x run.sh",
  "ln -s a b",
  "tee out.log",
  "tar xf archive.tar",
  "unzip pkg.zip",
  "patch -p1 < fix.diff",
  "truncate -s 0 log.txt",
  "dd if=/dev/zero of=x",
  "cat in.txt | tee out.txt",
  "find . -name '*.tmp' | xargs rm",
  "find . -name '*.tmp' -exec rm {} +",
  "awk '{print}' in > out",
  "sed -i 's/a/b/' f",
  "curl -o out.bin https://example.com/x",
  "pip install requests",
  "yarn add left-pad",
  "git commit -m x",
  "git checkout main",
  "docker build .",
  "env FOO=1 npm test",
  "sudo npm install",
  "powershell -c 'Set-Content a b'",
  "cmd /c copy a b",
];

const READERS = [
  "ls",
  "cat a.txt",
  "grep -r foo src",
  "git status",
  "git log --oneline",
  "git diff",
  "wc -l a.txt",
  "find . -name '*.ts'",
  "head -20 log.txt",
  "ps aux",
  "echo hi",
  "pwd",
  "which node",
];

test("every program that writes is recognised", () => {
  for (const command of WRITERS) {
    assert.equal(canWriteFiles(command), true, `not recognised as a write: ${command}`);
  }
});

test("routine reads are not mistaken for writes", () => {
  for (const command of READERS) {
    assert.equal(canWriteFiles(command), false, `mistaken for a write: ${command}`);
  }
});

test("a write anywhere in a chain or pipeline counts", () => {
  assert.equal(canWriteFiles("ls | head"), false);
  assert.equal(canWriteFiles("git status | grep foo"), false);
  // The pipe used to hide the second program entirely.
  assert.equal(canWriteFiles("cat a | tee out"), true);
  assert.equal(canWriteFiles("true && rm -f x"), true);
  assert.equal(canWriteFiles("echo a; touch b"), true);
  assert.equal(canWriteFiles("find . -name '*.tmp' | xargs rm"), true);
});

test("a build tool counts as a write even when the subcommand reads", () => {
  // `npm test` runs a project script, which can write anywhere. Treating it
  // as a read would mount the workspace read-only under the kernel sandbox.
  assert.equal(canWriteFiles("npm test"), true);
  assert.equal(canWriteFiles("npm run build"), true);
});

test("the program list is used by both the mount and the snapshot", () => {
  // A single source: if the set is empty the detector is dead, and a test that
  // only checks the function would still pass on one hardcoded answer.
  assert.ok(MUTATING_PROGRAMS.size > 40, `the program list shrank to ${MUTATING_PROGRAMS.size}`);
  for (const name of ["rm", "touch", "mkdir", "tee", "tar", "patch", "python", "bash", "npm"]) {
    assert.ok(MUTATING_PROGRAMS.has(name), `${name} is missing from the program list`);
  }
});
