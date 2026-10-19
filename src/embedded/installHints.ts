/**
 * How to install a tool this build does not bundle.
 *
 * The toolchain catalogue only carries entries whose download has been
 * verified byte-for-byte: a wrong hash fails at unpack time with an error that
 * looks like a corrupt download, and an unverified binary that runs is worse
 * still. pyOCD, probe-rs and esptool are all Python or Rust programs whose
 * releases change often; bundling them would mean re-verifying three large
 * archives on every release.
 *
 * The honest alternative is to say exactly how to install them. This table is
 * shown wherever a missing tool is reported, so the next step is never "look
 * it up yourself".
 */

export interface InstallHint {
  /** The command the user can run. */
  command: string;
  /** Where it comes from, for a user who would rather read the page. */
  url: string;
  /** What the command needs installed first, if anything. */
  requires?: string;
}

export const INSTALL_HINTS: Record<string, InstallHint> = {
  pyocd: {
    command: "pip install pyocd",
    url: "https://pyocd.io/docs/installing.html",
    requires: "Python 3.9 or newer on PATH",
  },
  "probe-rs": {
    command: "cargo install probe-rs-tools",
    url: "https://probe.rs/docs/getting-started/installation/",
    requires: "A Rust toolchain (rustup), or the prebuilt installer on the page",
  },
  esptool: {
    command: "pip install esptool",
    url: "https://docs.espressif.com/projects/esptool/en/latest/esp32/installation.html",
    requires: "Python 3.8 or newer on PATH",
  },
  west: {
    command: "pip install west",
    url: "https://docs.zephyrproject.org/latest/develop/getting_started/index.html",
    requires: "Python 3.8 or newer; Zephyr itself needs a workspace (`west init`)",
  },
  "arduino-cli": {
    command: "winget install ArduinoSA.CLI",
    url: "https://arduino.github.io/arduino-cli/latest/installation/",
  },
  pio: {
    command: "pip install platformio",
    url: "https://docs.platformio.org/en/latest/core/installation/methods/installer-script.html",
    requires: "Python 3.6 or newer on PATH",
  },
  idf: {
    command: "winget install Espressif.ESP-IDF",
    url: "https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/",
  },
  qemu: {
    command: "winget install SoftwareFreedomConservancy.QEMU",
    url: "https://www.qemu.org/download/#windows",
  },
  renode: {
    command: "winget install Renode.Renode",
    url: "https://renode.io/#downloads",
  },
  sigrok: {
    command: "winget install SIGROK.sigrok-cli",
    url: "https://sigrok.org/wiki/Downloads",
    requires: "A supported logic analyser or oscilloscope",
  },
  cppcheck: {
    command: "winget install Cppcheck.Cppcheck",
    url: "https://cppcheck.sourceforge.io/",
  },
  "clang-tidy": {
    command: "winget install LLVM.LLVM",
    url: "https://clang.llvm.org/get_started.html",
  },
  avrdude: {
    command: "winget install ArduinoSA.CLI  (then: arduino-cli core install arduino:avr)",
    url: "https://github.com/avrdudes/avrdude/wiki",
    requires: "arduino-cli bundles avrdude; a system install needs a programmer driver (libusb) ",
  },
  "dfu-util": {
    command: "winget install dfu-util.dfu-util",
    url: "https://dfu-util.sourceforge.net/",
    requires: "the board's DFU bootloader, plus a WinUSB driver bound to it",
  },
  "st-flash": {
    command: "winget install stlink.stlink",
    url: "https://github.com/stlink-org/stlink",
    requires: "ST-Link drivers",
  },
  jlink: {
    command: "winget install SEGGER.JLink",
    url: "https://www.segger.com/downloads/jlink/",
    requires: "a J-Link probe; the installer also ships JLinkGDBServer",
  },
  "gcc-riscv": {
    command: "winget install xPack.RISC-V.GCC  (or install the ESP-IDF tools)",
    url: "https://github.com/xpack-dev-tools/riscv-none-elf-gcc-xpack/releases",
    requires: "the toolchain's bin directory on PATH as riscv32-esp-elf-gcc or riscv64-unknown-elf-gcc",
  },
};

/**
 * One line per missing tool, ready to append to a report.
 *
 * A tool with no hint is listed by name only: inventing a command for it
 * would be worse than admitting this table does not cover it.
 */
export function installHintLines(missing: string[]): string[] {
  if (missing.length === 0) return [];
  const lines = ["", "to install:"];
  for (const kind of missing) {
    const hint = INSTALL_HINTS[kind];
    if (!hint) {
      lines.push(`  ${kind}: no install hint is known for this one`);
      continue;
    }
    lines.push(`  ${kind}: ${hint.command}${hint.requires ? `  (needs ${hint.requires})` : ""}`);
  }
  lines.push("  after installing, restart the app or press Refresh so the tool is found");
  return lines;
}
