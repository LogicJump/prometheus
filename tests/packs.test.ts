/** Toolchain packs: path safety, manifests, archive validation, the install transaction. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { assertPackId, isInside, packDir, packsRoot, ROOT_ENV, ensureRoot, isOwnedRoot, acquireRootLock } from "../src/packs/paths.ts";
import { parseManifest, readManifest, resolvePayloadPath, writeManifest, type PackManifest } from "../src/packs/manifest.ts";
import { planExtraction, validateMember, walkStats } from "../src/packs/archive.ts";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- paths ----------------------------------------------------------------

test("a pack id cannot escape its directory", () => {
  for (const bad of ["../x", "a/b", "a\\b", "C:\\x", "", ".", "..", ".hidden", "x".repeat(65), "A-Upper", "with space"]) {
    assert.throws(() => assertPackId(bad), /pack id/, `"${bad}" should be rejected`);
  }
  for (const good of ["arm-gnu-15.3.rel2-win32-x64", "esp-riscv32", "a", "x.y_z-1"]) {
    assert.doesNotThrow(() => assertPackId(good), `"${good}" should be accepted`);
  }
});

test("a relative toolchain home is refused, because it would resolve differently per process", () => {
  assert.throws(() => packsRoot({ [ROOT_ENV]: "relative/path" }), /must be an absolute path/);
  const absolute = process.platform === "win32" ? "C:\\prom-toolchains" : "/tmp/prom-toolchains";
  assert.equal(packsRoot({ [ROOT_ENV]: absolute }), absolute);
});

test("the root is the OS data dir, not the roaming profile", () => {
  const root = packsRoot({});
  assert.ok(!root.includes(".prometheus"), `root must not be under ~/.prometheus: ${root}`);
  if (process.platform === "win32") assert.match(root, /AppData[\\/]Local[\\/]Prometheus[\\/]toolchains$/);
});

test("containment treats a sibling with a shared prefix as outside", () => {
  const base = process.platform === "win32" ? "C:\\root\\packs" : "/root/packs";
  const inside = process.platform === "win32" ? "C:\\root\\packs\\a\\b" : "/root/packs/a/b";
  const sibling = process.platform === "win32" ? "C:\\root\\packs-evil\\x" : "/root/packs-evil/x";
  assert.equal(isInside(base, inside), true);
  assert.equal(isInside(base, sibling), false);
  assert.equal(isInside(base, base), true);
});

test("the root carries an ownership marker so prune never deletes a stranger's directory", () => {
  const root = scratch("prometheus-root-");
  assert.equal(isOwnedRoot(root), false);
  ensureRoot(root);
  assert.equal(isOwnedRoot(root), true);
  assert.ok(existsSync(join(root, "packs")));
  assert.ok(existsSync(join(root, "tmp")));
});

// ---- the install lock -----------------------------------------------------

test("a second install into the same root is refused rather than raced", () => {
  const root = scratch("prometheus-lock-");
  const first = acquireRootLock(root, { id: "pack-a" });
  try {
    assert.throws(() => acquireRootLock(root, { id: "pack-b" }), /in use by another Prometheus install/);
  } finally {
    first.release();
  }
  // Released: the next one gets in.
  const second = acquireRootLock(root, { id: "pack-c" });
  second.release();
});

test("a lock left by a dead process is broken, so a crash does not block installs forever", () => {
  const root = scratch("prometheus-lock-dead-");
  ensureRoot(root);
  // A pid that is certain not to exist: spawn nothing, use one past the max.
  writeFileSync(join(root, ".lock"), JSON.stringify({ pid: 4294967295, startedAt: new Date().toISOString() }));
  const lock = acquireRootLock(root);
  lock.release();
  assert.equal(existsSync(join(root, ".lock")), false);
});

test("a corrupt lock is broken rather than blocking forever", () => {
  const root = scratch("prometheus-lock-corrupt-");
  ensureRoot(root);
  writeFileSync(join(root, ".lock"), "{ this is not json");
  const lock = acquireRootLock(root);
  lock.release();
  assert.equal(existsSync(join(root, ".lock")), false);
});

test("a lock belonging to a live process is respected", () => {
  const root = scratch("prometheus-lock-live-");
  ensureRoot(root);
  // The test runner's own pid is definitely alive, and `breakStaleLock`
  // deliberately refuses to break our own record.
  const lock = acquireRootLock(root);
  try {
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.ppid ?? process.pid, startedAt: new Date().toISOString() }));
    assert.throws(() => acquireRootLock(root), /in use/);
  } finally {
    // The record now names another pid, so release() is a no-op by design;
    // clear it so the scratch directory is clean.
    assert.equal(existsSync(join(root, ".lock")), true);
    lock.release();
  }
});

// ---- manifest -------------------------------------------------------------

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: "arm-gnu-15.3.rel2-win32-x64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "win32",
    arch: "x64",
    installedAt: "2026-10-18T00:00:00.000Z",
    sources: [
      {
        url: "https://developer.arm.com/x.zip",
        archive: "zip",
        sha256: "a".repeat(64),
        bytes: 1000,
        hosts: ["developer.arm.com"],
      },
    ],
    license: { name: "GPL-3.0-or-later with GCC RLE", url: "https://developer.arm.com/license.txt", separateProcess: true },
    provides: ["gcc-arm"],
    executables: [{ name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" }],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    payload: { root: "payload", files: 10, bytes: 100, treeHash: "" },
    ...overrides,
  };
}

test("a well-formed manifest round-trips through the file", () => {
  const dir = scratch("prometheus-pack-");
  const manifest = parseManifest(validManifest(), "test");
  writeManifest(dir, manifest);
  const back = readManifest(dir);
  assert.deepEqual(back, manifest);
});

test("a manifest from a newer Prometheus is refused by name, not silently ignored", () => {
  assert.throws(() => parseManifest(validManifest({ schema: 2 })), /schema 2.*Update Prometheus/s);
});

test("a manifest cannot point a binary outside its own pack", () => {
  // A path that climbs out is refused at parse time, so it is never joined.
  assert.throws(
    () => parseManifest(validManifest({ executables: [{ name: "evil", path: "../../evil.exe" }] })),
    /must not contain "\.\."/,
  );
  assert.throws(
    () => parseManifest(validManifest({ executables: [{ name: "evil", path: "/usr/bin/sh" }] })),
    /must be relative/,
  );
  // Windows drive-absolute is the other spelling of the same attack.
  assert.throws(
    () => parseManifest(validManifest({ executables: [{ name: "evil", path: "C:\\Windows\\cmd.exe" }] })),
    /must not name a drive/,
  );
});

test("manifest validation rejects insecure or malformed sources", () => {
  const base = validManifest();
  const withSource = (patch: Record<string, unknown>) =>
    validManifest({ sources: [{ ...(base.sources as Record<string, unknown>[])[0], ...patch }] });

  assert.throws(() => parseManifest(withSource({ url: "http://example.com/x.zip" })), /must be https/);
  assert.throws(() => parseManifest(withSource({ sha256: "zzz" })), /64 lowercase hex/);
  assert.throws(() => parseManifest(withSource({ archive: "rar" })), /must be zip, tar\.xz or tar\.gz/);
  assert.throws(() => parseManifest(validManifest({ provides: [] })), /at least one toolchain kind/);
  assert.throws(() => parseManifest(validManifest({ validation: { command: "x", args: [], expect: "[" } })), /valid regular expression/);
});

test("resolving a payload path refuses to leave the payload", () => {
  const dir = scratch("prometheus-resolve-");
  const manifest = parseManifest(validManifest({ executables: [{ name: "gcc", path: "bin/gcc" }] }), "test");
  const inside = resolvePayloadPath(dir, manifest, "bin/gcc");
  assert.ok(inside.startsWith(join(dir, "payload")));
  assert.throws(() => resolvePayloadPath(dir, manifest, "../../etc/passwd"), /outside the pack payload/);
});

// ---- archive members ------------------------------------------------------

test("every traversal spelling is rejected", () => {
  const bad = [
    "../escape.txt",
    "../../escape.txt",
    "..\\..\\escape.txt",
    "a/../../b",
    "/abs/file",
    "\\abs\\file",
    "C:\\Windows\\file",
    "//server/share/file",
    "name\0nul",
    "x".repeat(901),
  ];
  for (const name of bad) {
    assert.notEqual(validateMember(name), null, `${JSON.stringify(name)} should be rejected`);
  }
  for (const good of ["ok.txt", "dir/file.c", "a/./b", "__MACOSX/._foo"]) {
    assert.equal(validateMember(good), null, `${JSON.stringify(good)} should be accepted`);
  }
});

test("stripping depends on how many top-level entries the archive has", () => {
  // A single wrapper directory is the normal shape of a vendor archive.
  const single = planExtraction(["tool-1.0/", "tool-1.0/bin/", "tool-1.0/bin/gcc", "tool-1.0/lib/a.a"]);
  assert.equal(single.strip, 1);
  assert.deepEqual(single.topLevels, ["tool-1.0"]);

  const multiple = planExtraction(["a/x", "b/y"]);
  assert.equal(multiple.strip, 0, "several top-level entries must not be stripped");

  // macOS resource forks are not payload and must not change the decision.
  const noisy = planExtraction(["tool/bin/gcc", "__MACOSX/._gcc"]);
  assert.equal(noisy.strip, 1);
  assert.deepEqual(noisy.topLevels, ["tool"]);
});

test("a violation is reported and blocks extraction even when a strip is possible", () => {
  const plan = planExtraction(["ok/x", "../evil"]);
  assert.equal(plan.violations.length, 1);
  assert.match(plan.violations[0], /parent reference/);
});

// ---- the install transaction ----------------------------------------------

import { installPack, type CatalogEntry, type InstallDeps } from "../src/packs/install.ts";
import { listPacks, packBinDirs, pruneTmp, removePack } from "../src/packs/registry.ts";

function entry(overrides: Record<string, unknown> = {}): CatalogEntry {
  return {
    manifest: parseManifest(validManifest(overrides), "test"),
    unpackedBytes: 1000,
    downloadBytes: 1000,
  };
}

/**
 * A fake toolchain: a directory with an executable that prints the expected
 * triple. The extractor writes it, so the whole transaction runs without a
 * network, a real archive, or a real compiler.
 */
function fakeDeps(options: { extractThrows?: boolean; validationFails?: boolean; badHash?: boolean; files?: number } = {}): InstallDeps {
  return {
    download: async (source, opts) => {
      writeFileSync(opts.destination, "archive bytes");
      if (options.badHash) {
        throw new Error(`checksum mismatch for ${source.url}\n  expected ${source.sha256}\n  received deadbeef`);
      }
      return { bytes: 13, sha256: source.sha256 };
    },
    list: async () => ["tool-1.0/", "tool-1.0/bin/", "tool-1.0/bin/gcc.exe"],
    extract: async (_archive, _format, destination) => {
      if (options.extractThrows) throw new Error("extraction failed: corrupt archive");
      const bin = join(destination, "bin");
      mkdirSync(bin, { recursive: true });
      const count = options.files ?? 1;
      for (let index = 0; index < count; index++) {
        writeFileSync(join(bin, index === 0 ? "gcc.exe" : `lib${index}.a`), index === 0 ? "binary" : "payload");
      }
    },
    walk: (root) => walkStats(root),
    hashTree: async () => "sha256:tree",
    runValidation: async () => (options.validationFails ? { ok: false, output: "x", reason: "validation failed: wrong triple" } : { ok: true, output: "arm-none-eabi" }),
    // 离线安装走这条路：字节从本地文件来，但校验一步都不能少。
    importArchive: async (source, file, opts) => {
      writeFileSync(opts.destination, readFileSync(file));
      if (options.badHash) {
        throw new Error(`checksum mismatch for ${file}\n  expected ${source.sha256}\n  received deadbeef`);
      }
      return { bytes: 13, sha256: source.sha256 };
    },
  };
}

test("a successful install commits one complete directory and leaves tmp empty", async () => {
  const root = scratch("prometheus-install-");
  const manifest = await installPack(entry(), { root, deps: fakeDeps() });

  const dir = join(root, "packs", manifest.id);
  assert.ok(existsSync(dir), "the pack directory exists");
  assert.ok(existsSync(join(dir, "pack.json")), "the manifest is inside the pack");
  assert.ok(existsSync(join(dir, "NOTICE.md")), "the licence notice is inside the pack");
  assert.ok(existsSync(join(dir, "payload", "bin", "gcc.exe")), "the payload is extracted");
  assert.equal(manifest.payload.files, 1);

  // The transaction directory is gone: no stray archive, no staging tree.
  assert.deepEqual(readdirSync(join(root, "tmp")), []);

  const packs = listPacks(root);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].status, "ok");
});

test("every failed install leaves nothing in packs/ and cleans tmp", async () => {
  const failures: [string, InstallDeps][] = [
    ["checksum mismatch", fakeDeps({ badHash: true })],
    ["extraction failure", fakeDeps({ extractThrows: true })],
    ["validation failure", fakeDeps({ validationFails: true })],
  ];

  for (const [label, deps] of failures) {
    const root = scratch("prometheus-fail-");
    await assert.rejects(installPack(entry(), { root, deps }), `"${label}" should fail`);
    assert.deepEqual(readdirSync(join(root, "packs")), [], `${label}: packs/ must be empty`);
    assert.deepEqual(readdirSync(join(root, "tmp")), [], `${label}: tmp/ must be empty`);
  }
});

test("an offline install uses the local archive and still checks its checksum", async () => {
  const root = scratch("prometheus-offline-");
  const archive = join(root, "arm.zip");
  writeFileSync(archive, "archive bytes");

  const manifest = await installPack(entry(), {
    root,
    localFiles: [archive],
    deps: fakeDeps(),
  });
  assert.ok(existsSync(join(root, "packs", manifest.id, "payload", "bin", "gcc.exe")));

  // The user's own file is still where they left it — the transaction copied
  // it, and nothing in this feature may delete a file the user picked.
  assert.ok(existsSync(archive), "the source archive must not be consumed");
});

test("an offline archive that does not match its manifest is refused", async () => {
  const root = scratch("prometheus-offline-bad-");
  const archive = join(root, "tampered.zip");
  writeFileSync(archive, "not the bytes the manifest describes");

  await assert.rejects(
    installPack(entry(), { root, localFiles: [archive], deps: fakeDeps({ badHash: true }) }),
    /checksum mismatch/,
  );
  assert.deepEqual(readdirSync(join(root, "packs")), [], "nothing installed");
  assert.deepEqual(readdirSync(join(root, "tmp")), [], "nothing left behind");
});

test("offline file count must match the manifest's source count", async () => {
  const root = scratch("prometheus-offline-count-");
  await assert.rejects(
    installPack(entry(), { root, localFiles: [], deps: fakeDeps() }),
    /1 archive\(s\) but 0 file\(s\)/,
  );
});

test("an unsafe archive is refused before extraction writes anything", async () => {  const root = scratch("prometheus-unsafe-");
  let extracted = false;
  const deps = {
    ...fakeDeps(),
    list: async () => ["tool/bin/gcc.exe", "../escape.txt"],
    extract: async () => {
      extracted = true;
    },
  };
  await assert.rejects(installPack(entry(), { root, deps }), /unsafe paths/);
  assert.equal(extracted, false, "extraction must not run when a member is unsafe");
  assert.deepEqual(readdirSync(join(root, "packs")), []);
});

test("an existing pack is not overwritten unless replace is asked for", async () => {
  const root = scratch("prometheus-collide-");
  await installPack(entry(), { root, deps: fakeDeps() });

  await assert.rejects(installPack(entry(), { root, deps: fakeDeps() }), /already installed/);

  // With replace, the old one is replaced atomically and only one remains.
  const manifest = await installPack(entry({ version: "15.3.rel3" }), { root, deps: fakeDeps({ files: 3 }), replace: true });
  const packs = listPacks(root);
  assert.equal(packs.length, 1, "a replace must not leave the old pack behind");
  assert.equal(manifest.payload.files, 3);
});

test("a cancelled install removes its transaction", async () => {
  const root = scratch("prometheus-cancel-");
  const controller = new AbortController();
  const deps: InstallDeps = {
    ...fakeDeps(),
    download: async (_source, opts) => {
      controller.abort();
      throw new Error("cancelled");
    },
  };
  await assert.rejects(installPack(entry(), { root, deps, signal: controller.signal }));
  assert.deepEqual(readdirSync(join(root, "packs")), []);
  assert.deepEqual(readdirSync(join(root, "tmp")), []);
});

// ---- registry -------------------------------------------------------------

test("a pack disappears from the list as soon as it is removed", async () => {
  const root = scratch("prometheus-remove-");
  const manifest = await installPack(entry(), { root, deps: fakeDeps() });
  assert.equal(listPacks(root).length, 1);

  await removePack(manifest.id, { root });
  assert.equal(listPacks(root).length, 0);
  assert.equal(existsSync(join(root, "packs", manifest.id)), false);
});

test("a directory with no manifest is reported as broken, not hidden", () => {
  const root = scratch("prometheus-broken-");
  ensureRoot(root);
  mkdirSync(join(root, "packs", "half-installed"), { recursive: true });

  const packs = listPacks(root);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].status, "broken");
  assert.match(String(packs[0].problem), /pack\.json/);
});

test("prune removes only old transactions and trash", async () => {
  const root = scratch("prometheus-prune-");
  ensureRoot(root);
  const old = join(root, "tmp", "txn-old");
  const fresh = join(root, "tmp", "txn-fresh");
  mkdirSync(old, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(old, "archive.zip"), "x".repeat(100));

  // Age the old one by backdating its mtime.
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(old, past, past);

  const result = await pruneTmp({ root });
  assert.equal(result.removed.length, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true, "a fresh transaction may still be in flight");
});

test("pack bin directories are keyed by the toolchain kind they provide", async () => {
  const root = scratch("prometheus-bins-");
  await installPack(entry(), { root, deps: fakeDeps() });

  const bins = packBinDirs(root);
  const forGcc = bins.get("gcc-arm");
  assert.ok(forGcc);
  assert.equal(forGcc.length, 1);
  // The directory must end in `payload/bin` (either separator), not double up
  // the payload prefix.
  assert.ok(forGcc[0].dir.endsWith(`payload${sep}bin`), `unexpected bin dir: ${forGcc[0].dir}`);
});

// ---- 环境注入 --------------------------------------------------------------

import { prependPath, toolEnv } from "../src/embedded/toolEnv.ts";

test("前置目录时不会在 Windows 上造出重复的 Path/PATH 键", () => {
  const dirs = ["C:\packs\arm\payload\bin"];
  // Windows 的系统环境用的是 `Path`。再写一个 `PATH` 会让环境里出现两个键，
  // 读到哪个取决于枚举顺序 —— 这正是"有时能找到编译器有时找不到"的来源。
  const env = prependPath({ Path: "C:\Windows\System32", FOO: "1" }, dirs);
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  assert.equal(pathKeys.length, 1, `只能有一个 PATH 键，实际有 ${pathKeys.join(", ")}`);
  assert.equal(env.Path, dirs[0] + ";" + "C:\Windows\System32");
  assert.equal(env.PATH, undefined);
});

test("用小写 PATH 的环境只保留 PATH 这一个键", () => {
  const env = prependPath({ PATH: "/usr/bin" }, ["/opt/pack/bin"]);
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  assert.equal(keys.length, 1);
  const sep = process.platform === "win32" ? ";" : ":";
  assert.equal(env[keys[0]], ["/opt/pack/bin", "/usr/bin"].join(sep));
});

test("已经在 PATH 里的目录会被提到前面而不是重复", () => {
  const env = prependPath({ PATH: "/usr/bin:/opt/pack/bin" }, ["/opt/pack/bin"]);
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = String(env.PATH).split(sep);
  assert.equal(parts[0], "/opt/pack/bin", "pack 必须排在系统目录之前");
  assert.equal(parts.filter((part) => part === "/opt/pack/bin").length, 1, "不能重复出现");
});

test("没有任何目录时不改动环境对象", () => {
  const original = { PATH: "/usr/bin" };
  assert.equal(prependPath(original, []), original);
});

test("toolEnv 不会修改 process.env", () => {
  const before = process.env.PATH;
  toolEnv();
  assert.equal(process.env.PATH, before, "process.env 必须一个字都不变");
});

// ---- 目录 ------------------------------------------------------------------

import { catalogFor, isInstallable, CATALOG } from "../src/packs/catalog.ts";

test("没有校验和的条目不会出现在可安装列表里", () => {
  // 安装器拒绝无校验的包，所以目录也不该把这种条目摆给用户看。
  const unverified = CATALOG.filter((entry) => !isInstallable(entry));
  const offered = catalogFor("win32", "x64");
  for (const entry of unverified) {
    assert.equal(offered.includes(entry), false, `${entry.id} 没有哈希却出现了`);
  }
});

test("目录按平台和架构过滤", () => {
  // 换一个平台就不该看到别的平台的包。
  const win = catalogFor("win32", "x64", { includeUnverified: true });
  for (const entry of win) assert.equal(entry.platform, "win32");
  // 产品目前只发 Windows，其它平台上目录应当是空的 —— 而不是列出装不上的
  // 东西让用户去点。
  assert.equal(catalogFor("linux", "x64", { includeUnverified: true }).length, 0);
  assert.equal(catalogFor("darwin", "arm64", { includeUnverified: true }).length, 0);
  // 同一个平台里换架构也一样。
  assert.equal(catalogFor("win32", "arm64", { includeUnverified: true }).length, 0);
});

test("目录里的每个条目都是 Windows 的 arm-none-eabi 工具链", () => {
  // 这条测试是产品范围的锚点：只做 Win 端时，目录里出现别的平台条目
  // 一定是有意加的，而不是拷贝粘贴带进来的。
  for (const entry of CATALOG) {
    assert.equal(entry.platform, "win32", `${entry.id} 不是 Windows 条目`);
    assert.equal(entry.arch, "x64", `${entry.id} 不是 x64 条目`);
    assert.deepEqual(entry.provides, ["gcc-arm"], `${entry.id} 提供的东西变了`);
  }
});

test("目录里每个条目本身是自洽的", () => {
  for (const entry of CATALOG) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9._-]*$/, `${entry.id} 不是合法的 pack id`);
    assert.ok(entry.sources.length > 0, `${entry.id} 没有来源`);
    for (const source of entry.sources) {
      assert.match(source.url, /^https:\/\//, `${entry.id} 的来源不是 https`);
      assert.ok(source.hosts.length > 0, `${entry.id} 没有声明允许的主机`);
    }
    assert.ok(entry.provides.length > 0, `${entry.id} 没有声明提供什么`);
    // 每个条目都必须能在装完后证明自己是可用的。
    assert.ok(entry.validation.command, `${entry.id} 没有验证命令`);
  }
});
