/**
 * GDB server endpoints: is one already listening, and who started it?
 *
 * Starting a second pyOCD against a probe that already has a server attached
 * fails with a USB error that names neither the port nor the other process.
 * Users hit this constantly — an Ozone or IDE session left open, a previous
 * agent run that crashed — so the tool checks first and either reuses the
 * server or says what is holding it.
 *
 * The check is a plain TCP connect: it answers "is something accepting
 * connections" without needing to know which program it is.
 */

import { connect } from "node:net";

/** The ports the supported servers bind by default. */
export const SERVER_PORTS = { pyocd: 3333, openocd: 3333, "probe-rs": 1337, jlink: 2331 } as const;

/** True when something accepts a TCP connection on the port. */
export function portOpen(port: number, host = "127.0.0.1", timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface PortCheck {
  port: number;
  open: boolean;
  /** A sentence the user can act on. */
  message: string;
}

/**
 * Check the port a server would bind, before starting it.
 *
 * An open port is not a failure: it may be exactly the server the user wants
 * to attach to. The caller decides — this returns the fact and a message that
 * names the two possibilities.
 */
export async function checkServerPort(port: number): Promise<PortCheck> {
  if (await portOpen(port)) {
    return {
      port,
      open: true,
      message:
        `something is already listening on port ${port}. ` +
        `If it is a GDB server for this board, pass remote: "localhost:${port}" to attach to it; ` +
        `otherwise close that program (an IDE or a previous session) and try again.`,
    };
  }
  return { port, open: false, message: `port ${port} is free` };
}

/**
 * The first free port at or above the default, so a second session can run.
 *
 * A fixed port means one debug session at a time; a small search lets a
 * second board coexist. It never reuses an open port, because that is the
 * case the check above exists for.
 */
export async function freePort(start: number, attempts = 10): Promise<number> {
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = start + offset;
    if (!(await portOpen(candidate))) return candidate;
  }
  return start;
}
