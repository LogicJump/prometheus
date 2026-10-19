/**
 * 子进程的环境构造。
 *
 * 这里有一条硬规则：**绝不修改 process.env**。
 *
 * 用户装了一个 pack，不代表他同意让 `PATH` 里突然多出一个编译器 —— 那会
 * 影响他自己的 shell、其他工具、甚至他自己的构建脚本。所以 pack 的 bin 只会
 * 出现在某一次 spawn 的环境里，且只有那一次。
 *
 * 另一个坑是 Windows 的键名大小写：系统给的是 `Path`，如果我们再写一个
 * `PATH`，环境里就会有两个键，行为取决于谁先被读到 —— 这是 Windows 上最
 * 经典的一类"有时能跑有时不能"的 bug。
 *
 * 第三个坑是继承面：嵌入式工具曾经整包继承 `process.env`，而 `embed_*`
 * 恰恰是不经过命令分类的那一路 —— 于是"沙箱会清掉密钥"这句话对编译器不成立。
 * 基础环境现在与 `bash` 同源，见 `embeddedBaseEnv`。
 */

import { join } from "node:path";
import type { ToolchainKind } from "./toolchain.ts";
import { packBinDirs } from "../packs/registry.ts";
import { sandboxEnv } from "../sandbox.ts";

/** 所有 pack 提供的 bin 目录，按 pack 的声明顺序。 */
export function allPackBinDirs(): string[] {
  const dirs: string[] = [];
  for (const entries of packBinDirs().values()) {
    for (const entry of entries) if (!dirs.includes(entry.dir)) dirs.push(entry.dir);
  }
  return dirs;
}

/**
 * 把目录前置到一个环境变量的 PATH 里。
 *
 * 查找已有键时不区分大小写：Windows 上是 `Path`，Linux/macOS 上是 `PATH`。
 * 找不到时按当前平台的惯用写法新建。
 */
export function prependPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;

  const existingKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = env[key] ?? "";

  // 去重，并保持调用方给的顺序（先给的优先）。
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of dirs) {
    const normalized = dir.replace(/[\\/]+$/, "");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ordered.push(normalized);
    }
  }

  // 若某个目录已经在 PATH 里，不再重复插入，但仍要提前，否则 pack 会被
  // 系统里同名的旧版本盖住。
  const rest = current
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .filter((dir) => !seen.has(dir.replace(/[\\/]+$/, "")));

  const sep = process.platform === "win32" ? ";" : ":";
  return { ...env, [key]: [...ordered, ...rest].join(sep) };
}

/**
 * 给嵌入式工具用的环境。
 *
 * `kinds` 为空表示带上所有 pack；指定时只带这些类型，避免一个 Rust pack
 * 的 `cargo` 意外盖住用户自己装的 cargo。
 *
 * 基础环境是沙箱那份，不是 `process.env`：编译器和烧录器同样是"agent 让它
 * 跑的命令"，没有理由比 `bash` 多拿一份 API key。用户自己设的编译器变量
 * （`ARM_TOOLCHAIN_PATH` 之类）由下面的 pass-through 按需放行。
 */
export function toolEnv(kinds?: ToolchainKind[], base: NodeJS.ProcessEnv = embeddedBaseEnv()): NodeJS.ProcessEnv {
  const dirs = kinds && kinds.length > 0
    ? (() => {
        const map = packBinDirs();
        const out: string[] = [];
        for (const kind of kinds) {
          for (const entry of map.get(kind) ?? []) if (!out.includes(entry.dir)) out.push(entry.dir);
        }
        return out;
      })()
    : allPackBinDirs();

  return prependPath({ ...base }, dirs);
}

/**
 * 嵌入式子进程可以额外继承的变量。
 *
 * 只放行"编译器/调试器自己会看"的那一类，按前缀和确切名字匹配，不整包继承。
 * 这份清单体现的是工具链的约定，不针对任何一家厂商：`ARM_`、`RISCV_`、
 * `ZEPHYR_`、`IDF_` 是生态里通用的前缀，`CMSIS_PACK_ROOT` 是 ARM 的标准变量。
 */
const EMBEDDED_ENV_NAMES = new Set([
  "CMSIS_PACK_ROOT",
  "NESTOOL",
  "OPENOCD_SCRIPTS",
  "PYOCD_CONFIG",
  "PROBE_RS_CONFIG",
  "JLINK_PATH",
  "JLINK_SCRIPTS_DIR",
  "ZEPHYR_BASE",
  "ZEPHYR_SDK_INSTALL_DIR",
  "IDF_PATH",
  "IDF_TOOLS_PATH",
  "ARDUINO_DIRECTORIES_DATA",
  "ARDUINO_DIRECTORIES_USER",
  "PROMETHEUS_TOOLCHAINS",
]);
const EMBEDDED_ENV_PREFIXES = ["ARM_", "RISCV_", "GCC_", "CMAKE_", "NINJA_", "WEST_", "PLATFORMIO_", "AVR_", "ESPRESSIF_"];

/** 沙箱环境 + 嵌入式工具链需要的那部分变量。 */
export function embeddedBaseEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sandboxEnv({ mode: "enforce", network: "off", allowedDirs: [] }) };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (EMBEDDED_ENV_NAMES.has(key) || EMBEDDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      // Windows 的键名大小写不敏感；沿用系统给的那个写法，避免同时存在两个键。
      if (!Object.keys(env).some((existing) => existing.toUpperCase() === key.toUpperCase())) env[key] = value;
    }
  }
  return env;
}

/** 一个 pack 自己声明的额外环境变量，占位符已展开。 */
export function packVars(manifest: { id: string; env: { vars: Record<string, string> } }, packDirectory: string): Record<string, string> {
  const state = join(packDirectory, "state");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.env.vars ?? {})) {
    out[key] = value.replace(/\{pack\}/g, packDirectory).replace(/\{state\}/g, state);
  }
  return out;
}
