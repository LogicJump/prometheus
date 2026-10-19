/**
 * Running firmware without a board.
 *
 * Half the questions an agent asks about embedded code — "does it boot",
 * "where does it hard-fault", "does this unit test pass" — do not need the
 * physical part. QEMU, Renode and Zephyr's `native_sim` all answer them, and
 * all three are sensitive to one thing that makes results non-reproducible:
 * time. A simulated timer that runs as fast as the host allows turns a
 * five-second test into a race, so the runner pins the clock and the seed.
 */

/** The emulators this module knows how to drive. */
export type Emulator = "qemu" | "renode" | "native_sim";

export interface EmulatorRequest {
  kind: Emulator;
  /** The executable path. */
  program: string;
  /** QEMU machine, e.g. `stm32vldiscovery` or `netduinoplus2`. */
  machine?: string;
  /** Zephyr target name for native_sim, e.g. `native_sim` or `qemu_x86`. */
  target?: string;
  /** The ELF to run. */
  elf?: string;
  /** How long to let it run, in milliseconds. */
  timeoutMs?: number;
  /** Stop as soon as stdout matches this. */
  until?: RegExp;
}

/**
 * The command line, with the determinism settings each emulator needs.
 *
 * QEMU: `-icount shift=auto,sleep=off` ties the virtual clock to instructions
 * rather than wall time, so a firmware's delay loops take the same number of
 * instructions on every host.
 *
 * Renode: `--disable-xwt -e` runs a script headlessly; the script sets a
 * deterministic virtual time base.
 *
 * native_sim: no `--rt`, which would tie it to real time and make it flaky.
 */
export function emulatorCommand(request: EmulatorRequest): { program: string; args: string[] } {
  switch (request.kind) {
    case "qemu": {
      const args = ["-M", request.machine ?? "netduinoplus2", "-nographic", "-icount", "shift=auto,sleep=off"];
      // A fixed seed and no RTC keep two runs comparable.
      args.push("-rtc", "base=2020-01-01T00:00:00");
      if (request.elf) args.push("-kernel", request.elf);
      return { program: request.program, args };
    }
    case "renode": {
      const args = ["--disable-xwt", "--plain"];
      if (request.elf) args.push("-e", `sysbus LoadELF @${request.elf}`);
      args.push("-e", "start");
      args.push("-e", 'emulation RunFor "00:00:05"');
      return { program: request.program, args };
    }
    case "native_sim": {
      // The binary produced by a native_sim build is itself the runner.
      return { program: request.elf ?? request.program, args: [] };
    }
  }
}

/**
 * Whether a target name is one an emulator can run.
 *
 * A `qemu_*` board in Zephyr is explicitly an emulator target; a physical
 * board name is not. This is the check that stops "run it in QEMU" from
 * becoming "run the STM32 image on the host and get a segfault".
 */
export function isEmulatorTarget(target: string | undefined): Emulator | null {
  const value = String(target ?? "").toLowerCase();
  if (!value) return null;
  if (value.startsWith("qemu_")) return "qemu";
  if (value.startsWith("native_sim") || value === "native_posix") return "native_sim";
  return null;
}

/** One line for a tool result. */
export function describeEmulator(request: EmulatorRequest): string {
  const command = emulatorCommand(request);
  return `${request.kind}: ${command.program} ${command.args.join(" ")}` +
    `\n(deterministic: virtual clock pinned, seed fixed; output stops after ${request.timeoutMs ?? 15_000} ms)`;
}
