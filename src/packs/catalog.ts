/**
 * 可以从应用里安装的工具链。
 *
 * 每一条都是一个**钉死的**版本：确切 URL、确切字节数、确切 SHA-256。没有
 * "最新版"这一说 —— 装到用户机器上的编译器必须是别人测过的那一个。
 *
 * 关于哈希：`sha256` 为空的条目不会出现在可安装列表里（`catalogFor` 会过滤
 * 掉），因为安装器拒绝无校验的包。发布前必须把哈希填上；留空的条目是明确
 * 的待办，而不是可以悄悄下载的缺省。
 *
 * 许可：这些工具都是独立的可执行文件，以子进程方式调用，不链接进
 * Prometheus。GPL 的义务（提供对应源码）通过 `license.sourceUrl` 记录，
 * 安装时写进 pack 的 NOTICE.md。
 */

import type { ArchiveFormat, PackManifest } from "./manifest.ts";

export interface CatalogSource {
  url: string;
  archive: ArchiveFormat;
  sha256: string;
  bytes: number;
  hosts: string[];
}

export interface CatalogEntryDef {
  id: string;
  name: string;
  version: string;
  provider: string;
  platform: NodeJS.Platform | "any";
  arch: "x64" | "arm64" | "any";
  /** 下载体积，给 UI 在下载前显示。 */
  downloadBytes: number;
  /** 解压后的体积，给磁盘检查用。 */
  unpackedBytes: number;
  sources: CatalogSource[];
  license: PackManifest["license"];
  provides: string[];
  executables: PackManifest["executables"];
  env: PackManifest["env"];
  validation: PackManifest["validation"];
  /** 同一工具链的多个版本时，数值大的优先。 */
  priority?: number;
}

const SRC = "https://gitlab.arm.com/api/v4/projects/tooling%2Fgnu-toolchains-for-arm/packages/generic/gnu-toolchain";

/**
 * Arm GNU Toolchain 15.3.rel2。
 *
 * URL 会被重定向到 AWS S3，所以两个主力域都列进 hosts —— 下载器只信任
 * 白名单里的主机，这既是安全边界，也是重定向必须被允许的原因。
 */
const ARM_HOSTS = ["gitlab.arm.com", "gitlabcommunity-eu1-eu-west-1-prod-packages.s3.eu-west-1.amazonaws.com"];

const ARM_LICENSE: PackManifest["license"] = {
  name: "GPL-3.0-or-later with GCC Runtime Library Exception; newlib BSD",
  url: `${SRC}/15.3.rel2/EULA.txt`,
  sourceUrl: `${SRC}/15.3.rel2/arm-gnu-toolchain-src-snapshot-15.3.rel2.tar.xz`,
  separateProcess: true,
};

export const CATALOG: CatalogEntryDef[] = [
  {
    id: "arm-gnu-15.3.rel2-win32-x64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "win32",
    arch: "x64",
    // 实测 Content-Length：289240072 字节
    downloadBytes: 289_240_072,
    unpackedBytes: 1_077_000_000,
    sources: [
      {
        url: `${SRC}/15.3.rel2/arm-gnu-toolchain-15.3.rel2-mingw-w64-x86_64-arm-none-eabi.zip`,
        archive: "zip",
        // 实测：2026-10-18 下载 289,240,072 字节后计算得到。
        sha256: "0daff4141d4f62ad1e9794ca8bd430ef730f07fd78f6d71d2ffdffc21db8cb9e",
        bytes: 289_240_072,
        hosts: ARM_HOSTS,
      },
    ],
    license: ARM_LICENSE,
    provides: ["gcc-arm"],
    executables: [
      { name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-gdb", path: "bin/arm-none-eabi-gdb.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-size", path: "bin/arm-none-eabi-size.exe", toolchain: "gcc-arm" },
    ],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    priority: 10,
  },
  {
    id: "arm-gnu-15.3.rel2-linux-x64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "linux",
    arch: "x64",
    downloadBytes: 159_700_000,
    unpackedBytes: 1_077_000_000,
    sources: [
      {
        url: `${SRC}/15.3.rel2/arm-gnu-toolchain-15.3.rel2-x86_64-arm-none-eabi.tar.xz`,
        archive: "tar.xz",
        sha256: "",
        bytes: 159_700_000,
        hosts: ARM_HOSTS,
      },
    ],
    license: ARM_LICENSE,
    provides: ["gcc-arm"],
    executables: [
      { name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-gdb", path: "bin/arm-none-eabi-gdb", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-size", path: "bin/arm-none-eabi-size", toolchain: "gcc-arm" },
    ],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    priority: 10,
  },
  {
    id: "arm-gnu-15.3.rel2-darwin-arm64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "darwin",
    arch: "arm64",
    downloadBytes: 143_700_000,
    unpackedBytes: 1_077_000_000,
    sources: [
      {
        url: `${SRC}/15.3.rel2/arm-gnu-toolchain-15.3.rel2-darwin-arm64-arm-none-eabi.tar.xz`,
        archive: "tar.xz",
        sha256: "",
        bytes: 143_700_000,
        hosts: ARM_HOSTS,
      },
    ],
    license: ARM_LICENSE,
    provides: ["gcc-arm"],
    executables: [
      { name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-gdb", path: "bin/arm-none-eabi-gdb", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-size", path: "bin/arm-none-eabi-size", toolchain: "gcc-arm" },
    ],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    priority: 10,
  },
];

/** 一个条目是否具备安装条件：有哈希才可能出现给用户。 */
export function isInstallable(entry: CatalogEntryDef): boolean {
  return entry.sources.length > 0 && entry.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256));
}

/** 当前平台能装的条目。 */
export function catalogFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: { includeUnverified?: boolean } = {},
): CatalogEntryDef[] {
  return CATALOG.filter((entry) => {
    if (entry.platform !== "any" && entry.platform !== platform) return false;
    if (entry.arch !== "any" && entry.arch !== arch) return false;
    return options.includeUnverified ? true : isInstallable(entry);
  }).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));
}

export function catalogEntry(id: string): CatalogEntryDef | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** 把目录条目变成安装器要的 manifest + 体积。 */
export function toInstallEntry(entry: CatalogEntryDef): {
  manifest: PackManifest;
  unpackedBytes: number;
  downloadBytes: number;
} {
  const manifest: PackManifest = {
    schema: 1,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    provider: entry.provider,
    platform: String(entry.platform),
    arch: String(entry.arch),
    installedAt: new Date().toISOString(),
    sources: entry.sources,
    license: entry.license,
    provides: entry.provides,
    executables: entry.executables,
    env: entry.env,
    validation: entry.validation,
    payload: { root: "payload", files: 0, bytes: 0, treeHash: "" },
  };
  return { manifest, unpackedBytes: entry.unpackedBytes, downloadBytes: entry.downloadBytes };
}
