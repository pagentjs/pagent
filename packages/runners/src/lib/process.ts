// The harness process a runner starts must not outlive the runner's caller. It runs in its own process group,
// and the whole group goes when the server dies (this runner is re-parented), when the pipe to the server breaks,
// or when the runner itself is told to stop. Otherwise a server restart leaves a headless turn running on a
// session nobody sees, and the next turn becomes a second writer on it.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

// Why a harness could not be started (its binary is not there), by its process.
const failed = new WeakMap<ChildProcessWithoutNullStreams, string>();

/** Why the harness never ran ("claude not found"), or undefined: it started. */
export const spawnError = (child: ChildProcessWithoutNullStreams): string | undefined => failed.get(child);

/** Signal the harness's whole group: it and what it started (a shell tool's background process, an LSP, an MCP server). */
function signalGroup(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals | 0): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Stop the harness and everything it started: SIGTERM to its group, then, if any of it is still there after `ms`
 * (default 3 s), SIGKILL. Resolves once the group is gone.
 */
export async function stopGroup(child: ChildProcessWithoutNullStreams, ms = 3000): Promise<void> {
  try {
    child.stdin.end();
  } catch {}
  if (!signalGroup(child, "SIGTERM")) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    if (!signalGroup(child, 0)) return;
  }
  signalGroup(child, "SIGKILL");
}

export function spawnHarness(command: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], detached: true }) as ChildProcessWithoutNullStreams;
  // Not there (ENOENT), or not runnable: said, not thrown (an 'error' nobody hears ends the runner). Its 'close' follows.
  child.on("error", (e: NodeJS.ErrnoException) => failed.set(child, e.code === "ENOENT" ? `${command} not found` : `${command} could not start (${e.message})`));
  child.stdin.on("error", () => {}); // EPIPE: it went away before it read what it was given (its 'close' says so)
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void stopGroup(child).then(() => process.exit(1));
  };

  const parent = process.ppid;
  const orphaned = setInterval(() => process.ppid !== parent && stop(), 1000);
  process.stdout.on("error", stop); // EPIPE: the server is gone
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, stop);
  child.on("close", () => clearInterval(orphaned));
  return child;
}
