/**
 * Round-three security boundaries.
 *
 * Each test names the escape it closes: a junction that leaves the workspace,
 * an interpreter that reads the files the path check is supposed to protect,
 * an embedded tool that spawns with the full environment, and a project hook
 * that runs before the user has trusted the checkout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyCommand, sandboxEnv } from "../src/sandbox.ts";
import { isWorkspaceConfinedPath, resolveSafePath } from "../src/permissions.ts";
import { projectHooksTrusted, trustProjectHooks, loadHooks } from "../src/hooks.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "prometheus-sec-"));
}

const ENFORCE = { mode: "enforce" as const, network: "off" as const, allowedDirs: [] };

/* ---------- 2.1 a junction or symlink cannot leave the workspace ---------- */

test("a junction that points outside the workspace is refused", async (t) => {
  const root = workspace();
  const outside = workspace();
  try {
    writeFileSync(join(outside, "secret.txt"), "private\n", "utf8");
    const link = join(root, "esc");
    if (process.platform === "win32") {
      // A junction needs no elevation and passes every lexical check, which is
      // exactly why the confinement test has to resolve the real path.
      execFileSync("cmd", ["/c", "mklink", "/J", link, outside], { stdio: "pipe" });
    } else {
      try {
        symlinkSync(outside, link, "dir");
      } catch {
        t.skip("this account cannot create symlinks");
        return;
      }
    }
    assert.throws(() => resolveSafePath("esc/secret.txt", root, []), /escapes the workspace/);
    assert.equal(isWorkspaceConfinedPath(join(root, "esc", "secret.txt"), root, []), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a new file inside a real directory is still allowed, and its parent is checked", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const target = resolveSafePath("src/new-file.ts", root, []);
    assert.equal(target, join(root, "src", "new-file.ts"));
    assert.equal(isWorkspaceConfinedPath(join(root, "src", "new-file.ts"), root, []), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- 2.2 interpreters and network ---------- */

test("an inline interpreter script that reads outside the workspace is refused", () => {
  const root = workspace();
  try {
    for (const command of [
      `python -c "print(open('/etc/passwd').read())"`,
      `node -e "require('fs').readFileSync('/etc/passwd')"`,
      `powershell -Command "Get-Content C:/Windows/win.ini"`,
    ]) {
      const verdict = classifyCommand(command, root, ENFORCE);
      assert.notEqual(verdict.class, "allow", `should not be allowed: ${command}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inline interpreter script is a confirm even when it stays inside the workspace", () => {
  const root = workspace();
  try {
    const inside = classifyCommand(`python -c "print('hi')"`, root, ENFORCE);
    assert.equal(inside.class, "confirm", "the script body cannot be judged by a path scan");
    // A plain script file is ordinary work.
    assert.equal(classifyCommand("python script.py", root, ENFORCE).class, "allow");
    assert.equal(classifyCommand("node --version", root, ENFORCE).class, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inline interpreter code that reaches the network is refused when the policy is off", () => {
  const root = workspace();
  try {
    for (const command of [
      `python -c "import urllib.request; urllib.request.urlopen('http://x')"`,
      `node -e "require('https').get('http://x')"`,
      `powershell -Command "Invoke-WebRequest http://x"`,
    ]) {
      assert.equal(classifyCommand(command, root, ENFORCE).class, "deny", command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the proxy policy is reported as unimplemented rather than silently treated as off", () => {
  const root = workspace();
  try {
    // The refusal names the policy, so the user learns it is not a working switch.
    const verdict = classifyCommand("curl http://example.com", root, { ...ENFORCE, network: "proxy" });
    assert.equal(verdict.class, "confirm");
    assert.match(String(verdict.reason), /proxy/i);
    // "open" means open.
    assert.equal(classifyCommand("curl http://example.com", root, { ...ENFORCE, network: "open" }).class, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- 2.3 embedded tools spawn with the sandboxed environment ---------- */

test("the embedded environment drops secrets like a sandboxed command does", () => {
  const saved = { ...process.env };
  process.env.PROMETHEUS_API_KEY = "sk-secret";
  process.env.SOME_VENDOR_TOKEN = "token-value";
  try {
    const env = sandboxEnv(ENFORCE);
    assert.equal(env.PROMETHEUS_API_KEY, undefined);
    assert.equal(env.SOME_VENDOR_TOKEN, undefined);
    assert.ok(env.PATH);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

/* ---------- 2.4 project hooks are trusted once, explicitly ---------- */

test("a project hook is not loaded until the checkout is trusted", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, ".prometheus"), { recursive: true });
    writeFileSync(
      join(root, ".prometheus", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ command: "echo pwned" }] } }),
      "utf8",
    );
    assert.equal(projectHooksTrusted(root), false);
    assert.deepEqual(
      loadHooks(root).filter((hook) => hook.event === "PreToolUse"),
      [],
      "an untrusted checkout contributes no project hooks",
    );

    trustProjectHooks(root);
    assert.equal(projectHooksTrusted(root), true);
    assert.equal(loadHooks(root).filter((hook) => hook.event === "PreToolUse").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the trust marker is tied to the file, so editing hooks re-asks", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, ".prometheus"), { recursive: true });
    const file = join(root, ".prometheus", "hooks.json");
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ command: "echo one" }] } }), "utf8");
    trustProjectHooks(root);
    assert.equal(projectHooksTrusted(root), true);
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ command: "echo two" }] } }), "utf8");
    assert.equal(projectHooksTrusted(root), false, "a changed hook file needs a fresh decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- a git worktree is not a repository to trust ---------- */

test("an untrusted worktree still loads no project hooks", () => {
  const root = workspace();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
    mkdirSync(join(root, ".prometheus"), { recursive: true });
    writeFileSync(join(root, ".prometheus", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ command: "echo x" }] } }), "utf8");
    assert.equal(loadHooks(root).filter((hook) => hook.event === "Stop").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
