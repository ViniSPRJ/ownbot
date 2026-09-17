import { createConnection } from "node:net";

/** Probe the X socket, not the lock file (which survives a container stop). */
export function displayAvailable(env = process.env): Promise<boolean> {
  if (env.COMPUTER_HEADED !== "on") return Promise.resolve(true);
  const match = /^:(\d+)(?:\.\d+)?$/.exec(env.DISPLAY ?? "");
  if (!match) return Promise.resolve(false);
  return probeDisplaySocket(`/tmp/.X11-unix/X${match[1]}`);
}
export function probeDisplaySocket(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ path });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
