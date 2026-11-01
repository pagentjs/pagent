// The browser shell, built from the current sources (what `pagent serve` serves from packages/shell/dist).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./app.ts";

const shell = join(repo, "packages/shell");
// Outside the repository (nothing for git to see if a process dies holding it), one per checkout.
const lock = join(tmpdir(), `pagent-shell-build-${createHash("sha1").update(repo).digest("hex").slice(0, 10)}`);

/** Newest modification time of a file, or of any file under a folder. */
const newest = (path: string): number =>
  !existsSync(path) ? 0 : statSync(path).isDirectory() ? readdirSync(path).reduce((m, f) => Math.max(m, newest(join(path, f))), 0) : statSync(path).mtimeMs;
const fresh = () => newest(join(shell, "dist", "index.html")) >= Math.max(newest(join(shell, "src")), newest(join(shell, "index.html")), newest(join(repo, "packages/bridge/src")));

let built = false;
/**
 * The e2e files run at once, each in a process of its own, and two builds at once trip over each other's output folder:
 * one builds (holding a lock folder), the others wait, then find it fresh and take it.
 */
export function buildShell() {
  if (built) return;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 1500) rmSync(lock, { recursive: true, force: true }); // five minutes: one that died holding it
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    if (!fresh()) execFileSync(process.execPath, [join(shell, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "error"], { cwd: shell, stdio: "inherit" });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  built = true;
}
