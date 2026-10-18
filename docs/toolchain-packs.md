# Toolchain packs

Prometheus ships as a thin desktop app. Compilers are not inside the installer;
they are downloaded on demand into one directory that the app owns and the user
can delete.

This document is about the structure, because the whole feature succeeds or
fails on it. The worry it was designed against is concrete and already visible
in this repository: eleven `release*` directories totalling 2.8 GB of stale
build output. A feature that pulls 300 MB–2 GB of compilers down can produce
exactly that kind of mess, at scale, on someone else's disk.

## The invariant

**Every byte this feature writes lives under one root, and every pack is one
directory that can be deleted with no residue.**

Everything below exists to keep that true under interruption, disk exhaustion,
corruption, cancellation, and two windows open at once.

| Rule | How it is enforced |
|---|---|
| One root | `src/packs/paths.ts` owns every path; nothing else builds one |
| No host mutation | `src/embedded/toolEnv.ts` builds a per-spawn env; `process.env` is never written, and a test asserts it |
| One pack, one directory | `pack.json` sits inside the directory it describes; there is no index file to desync |
| Nothing half-installed is visible | download → verify → extract to staging → validate by executing → atomic rename |
| Pinned artefacts | https only, SHA-256 required, redirect host allowlist |
| Data, not code | no install scripts, no post-install hooks; only archives are extracted |

## Disk layout

```
%LOCALAPPDATA%\Prometheus\toolchains\      ← one root
  root.json                                ← ownership marker
  .lock                                    ← one install at a time
  packs\
    arm-gnu-15.3.rel2-win32-x64\           ← one pack, deletable as a unit
      pack.json                            ← the only record of this pack
      NOTICE.md                            ← licence + GPL source offer
      payload\                             ← extracted tree, immutable after commit
        bin\arm-none-eabi-gcc.exe
    .trash-<id>-<epoch>\                   ← pending deletion
  tmp\
    txn-<random>\                          ← in-flight install
```

The root is the OS data directory, **not** `~/.prometheus`. That directory holds
small JSON that roams with a Windows profile and gets swept into backups;
putting gigabytes of compilers there would make every backup expensive. It is
also not Electron's `userData`, because the CLI (`bin/prometheus.js`) shares the
same root and must not depend on Electron.

`PROMETHEUS_TOOLCHAIN_HOME` overrides it. The value must be absolute: a relative
path would resolve differently in the CLI and in the app.

## The install transaction

`src/packs/install.ts`. Each phase can fail; what it leaves behind is the
contract.

| Phase | Does | A failure here leaves |
|---|---|---|
| preflight | id, manifest, checksum presence, free-space check (`archive + unpacked × 1.15`) | nothing written |
| lock | `<root>\.lock`, broken only when its pid is dead | a lock file |
| download | streams into `tmp\txn-*`, hashing as it writes | a partial archive in the txn |
| verify | SHA-256; a mismatch deletes the archive | nothing in staging |
| list | every member validated **before** a file is written | nothing in staging |
| extract | into `txn\payload` — the tree already has its final shape | the txn |
| inspect | walk the result: symlinks out of the pack, setuid bits, file count | the txn |
| validate | run the toolchain and match its output; GCC also proves it has a C library | the txn |
| commit | write `pack.json` + `NOTICE.md`, then one atomic rename | the previous pack, intact |

Two details that are easy to get wrong and were:

- The transaction directory is removed in `finally` **only if it still exists**.
  After a successful commit the txn *is* the destination, and a naive `rm` there
  deletes the pack that was just installed.
- The staging `payload` directory must exist before extraction: `tar -C` needs
  it, and the failure otherwise appears after a 30-second download, which is the
  most confusing possible place for it.

Power loss before the rename leaves a `txn` directory (pruned on next start).
Power loss during the rename is safe because rename is atomic: either the old
directory or the new one exists, never a mixture.

## The lock

Two windows are two host processes, and both can reach `installPack`. Without a
lock, two installs of the same pack stage into different transaction
directories and then race on the commit rename: one wins, and the other gets
`EPERM` after ten minutes of downloading while its staging copy is orphaned.

Staleness is decided by **pid, not age**. A real install can take longer than
any timeout worth writing down, but a dead pid never returns. A record whose pid
belongs to a live process is not broken — including the caller's own, so a hung
host cannot lock installs out forever without a human deleting the file.

## Extraction with zero dependencies

Windows ships `%SystemRoot%\System32\tar.exe`, which is bsdtar 3.5.2
(libarchive) and handles **both** `.zip` and `.tar.xz`. Verified on this
machine. macOS and Linux use `/usr/bin/tar`.

- The binary is always resolved to an **absolute** path. Resolving `tar` through
  `PATH` would let a directory earlier in `PATH` decide what runs.
- `TAR_OPTIONS` is cleared in the child environment: it is an injection vector
  and the user's own setting must not silently change how we extract.
- Members are validated before extraction: no absolute paths, no drive letters,
  no `..` segment splitting on **both** separators (`..\..\evil` is the Windows
  spelling), no NUL, no name over 900 characters.

## Discovery and environment

`src/embedded/toolchain.ts` looks for a tool in this order:

```
PROMETHEUS_TOOLCHAINS  →  packs  →  platform install roots  →  PATH
```

The env var is an explicit instruction. A pack is an explicit install the app
can verify. `PATH` is the least trustworthy — Homebrew's `arm-none-eabi-gcc` is
a compiler with no C library, and finding it is worse than finding nothing.

Pack binaries reach a child only through the environment of that one spawn
(`src/embedded/toolEnv.ts`). It is worth being precise about why: writing
`process.env.PATH` would work in the short term and would leak the pack into
every later subprocess, including the user's own shell tools.

## What the UI answers

The settings page is deliberately short. The first line is the root, the bytes
used, and the bytes free, because that is the literal answer to "where did the
disk go". Under it: what is installed, and what can be installed. Nothing else.

## Scope

Only Windows is shipped (`win32`, x64). Other platforms resolve a different root
and the rest of the machinery is written to work there, but the catalogue
contains no entries for them — an installable list is a promise that the
artefacts were downloaded and hashed, and we have only made that promise for
Windows. `catalogFor` filters by platform and arch, so adding a platform later
means adding tested entries, not changing code.

## What the installer actually weighs

Measured on 2026-10-18, `electron-builder --win --publish never`:

| | |
|---|---|
| `Prometheus-0.1.0-x64.exe` (NSIS) | 106.5 MB |
| `release\win-unpacked\` | 370 MB |
| `app.asar` — our code | **1.1 MB** |

The other 369 MB is Electron. Nothing in this feature adds a single byte to
those numbers, because packs are user data under `%LOCALAPPDATA%` and there is
no `extraResources` entry to bundle them. That is the whole point of the design:
the installer stays the size of a framework, and compilers arrive only if
someone builds firmware.
