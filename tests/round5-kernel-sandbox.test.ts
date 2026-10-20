/**
 * The WSL2 kernel sandbox: path translation, the wrapper script, the argv that
 * forms the boundary, and the POSIX path classification that goes with it.
 *
 * The parts that need a real WSL are exercised by `availability()` returning
 * `absent` on CI; the boundary itself is asserted as an argument list, which is
 * what actually decides whether a run is confined.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxArgs, wrapScript, toWslPath, decodeWslOutput, describeSandbox } from "../src/kernelSandbox.ts";
import { classifyCommand, normalizePosix, posixPathsOutside, posixCdOutside } from "../src/sandbox.ts";

/* ---------- path translation ---------- */

test("a Windows path becomes its WSL mount path", () => {
  assert.equal(toWslPath("G:\\Develop\\Prometheus"), "/mnt/g/Develop/Prometheus");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
  assert.equal(toWslPath("C:\\Users\\Admin"), "/mnt/c/Users/Admin");
  // Already POSIX: unchanged.
  assert.equal(toWslPath("/mnt/g/x"), "/mnt/g/x");
});

test("dot segments resolve lexically like a shell cd", () => {
  assert.equal(normalizePosix("/mnt/g/a/../b"), "/mnt/g/b");
  assert.equal(normalizePosix("/mnt/g/a/./b/"), "/mnt/g/a/b");
  assert.equal(normalizePosix("/mnt/g/../../c"), "/c");
  assert.equal(normalizePosix("/"), "/");
});

/* ---------- the wrapper ---------- */

test("the wrapper cds into the workspace and passes the command as arguments", () => {
  const script = wrapScript({ cwd: "G:\\Develop\\Prometheus", network: "off", writable: true, timeoutMs: 30_000 });
  assert.match(script, /WORK='\/mnt\/g\/Develop\/Prometheus'/);
  assert.match(script, /cd "\$WORK"/);
  assert.match(script, /timeout 30s "\$@"/);
  // The command must never be interpolated into the script: `"$@"` is the
  // whole reason a command containing quotes cannot change what runs.
  assert.ok(!script.includes("rm -rf"), "the wrapper must not embed the command");
});

test("read-only mode refuses to run when the bind cannot be made", () => {
  const script = wrapScript({ cwd: "G:\\x", network: "off", writable: false });
  assert.match(script, /remount,bind,ro/);
  assert.match(script, /refusing to run/);
  assert.match(script, /exit 97/);
});

test("writable mode does not attempt a read-only bind", () => {
  const script = wrapScript({ cwd: "G:\\x", network: "off", writable: true });
  assert.ok(!script.includes("remount,bind,ro"));
});

/* ---------- the argv is the boundary ---------- */

test("network off adds the network namespace; network open does not", () => {
  const base = { command: "true", cwd: "G:\\x", writable: true };
  const off = sandboxArgs({ ...base, network: "off" });
  const open = sandboxArgs({ ...base, network: "open" });
  assert.ok(off.includes("--net"));
  assert.ok(!open.includes("--net"));
  // Both are user and mount namespaces mapped to root inside only.
  for (const args of [off, open]) {
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("--map-root-user"));
    assert.ok(args.includes("--mount"));
    assert.ok(args.includes("--pid"));
  }
});

test("the environment is cleared so the Windows PATH does not leak in", () => {
  const args = sandboxArgs({ command: "env", cwd: "G:\\x", network: "off", writable: true });
  const index = args.indexOf("env");
  assert.ok(index > 0);
  assert.equal(args[index + 1], "-i");
  const path = args.find((arg) => arg.startsWith("PATH="));
  assert.ok(path);
  assert.ok(!path.includes("mnt/c"), "the WSL PATH must not carry Windows directories");
});

test("the command is the last argv element, verbatim", () => {
  const command = `echo "a b" && ls 'x y'`;
  const args = sandboxArgs({ command, cwd: "G:\\x", network: "off", writable: true });
  assert.equal(args[args.length - 1], command);
  assert.equal(args[args.length - 2], "-c");
  assert.equal(args[args.length - 3], "/bin/bash");
});

test("a named distro is passed through; none omits the flag", () => {
  const withDistro = sandboxArgs({ command: "true", cwd: "G:\\x", network: "off", writable: true }, "Ubuntu");
  assert.deepEqual(withDistro.slice(0, 2), ["-d", "Ubuntu"]);
  const without = sandboxArgs({ command: "true", cwd: "G:\\x", network: "off", writable: true });
  assert.notEqual(without[0], "-d");
});

/* ---------- decoding wsl.exe output ---------- */

test("UTF-16LE output with NUL bytes decodes to the distro name", () => {
  const text = "Ubuntu\r\ndocker-desktop\r\n";
  const buffer = Buffer.from(text, "utf16le");
  assert.equal(decodeWslOutput(buffer), "Ubuntu\r\ndocker-desktop\r\n");
});

test("UTF-8 output is left alone", () => {
  assert.equal(decodeWslOutput("Ubuntu\n"), "Ubuntu\n");
});

/* ---------- POSIX classification ---------- */

test("a sandboxed command is judged by POSIX paths, not Windows ones", () => {
  const policy = { mode: "enforce", network: "open", allowedDirs: [] } as const;
  const cwd = "G:\\Develop\\Prometheus";
  // The same command is a path escape under Windows semantics and a no-op
  // under POSIX ones, because `/mnt/g/...` does not mean anything on Windows.
  assert.equal(classifyCommand("cd /mnt/g/Develop/Prometheus && ls", cwd, policy, { paths: "posix" }).class, "allow");
  assert.equal(classifyCommand("cd /mnt/g/Develop/Prometheus && ls", cwd, policy, { paths: "windows" }).class, "deny");
});

test("paths under the workspace pass and paths outside it are named in full", () => {
  const cwd = "G:\\Develop\\Prometheus";
  assert.deepEqual(posixPathsOutside("ls src/tools", cwd, []), []);
  assert.deepEqual(posixPathsOutside("cat /mnt/g/Develop/Prometheus/README.md", cwd, []), []);
  const outside = posixPathsOutside("cat /mnt/c/Windows/win.ini", cwd, []);
  assert.deepEqual(outside, ["/mnt/c/Windows/win.ini"]);
  assert.deepEqual(posixPathsOutside("head -1 /etc/passwd", cwd, []), ["/etc/passwd"]);
});

test("/dev, /tmp and /proc are part of the sandbox image, not the user's system", () => {
  const cwd = "G:\\Develop\\Prometheus";
  assert.deepEqual(posixPathsOutside("echo hi > /dev/null", cwd, []), []);
  assert.deepEqual(posixPathsOutside("ls /tmp", cwd, []), []);
  assert.deepEqual(posixPathsOutside("cat /proc/cpuinfo", cwd, []), []);
});

test("a cd out of the workspace in POSIX form is refused", () => {
  const cwd = "G:\\Develop\\Prometheus";
  assert.equal(posixCdOutside("cd /mnt/g/Develop/Prometheus/src && ls", cwd, []), null);
  assert.equal(posixCdOutside("cd / && cat etc/passwd", cwd, []), "/");
  assert.equal(posixCdOutside("cd /mnt/c && ls", cwd, []), "/mnt/c");
});

/* ---------- description ---------- */

test("the status line says what a sandboxed run can and cannot do", () => {
  const ready = describeSandbox({ state: "ready", distro: "Ubuntu" }, { network: "off", writable: false });
  assert.match(ready, /Ubuntu/);
  assert.match(ready, /read-only/);
  assert.match(ready, /no network/);
  const absent = describeSandbox({ state: "absent", reason: "WSL is not installed" }, { network: "off", writable: true });
  assert.match(absent, /Policy sandbox only/);
  assert.match(absent, /WSL is not installed/);
});
