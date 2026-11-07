// Which program a command runs: a harness updated since one of its processes started (Claude Code's own updater moves
// its link to a new version, Homebrew to a new Caskroom folder, npm writes the same path again) runs something else
// now, so that process is behind (agents/tui.ts restarts such a TUI, agents/thread.ts such a service).
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The program `command` runs on this PATH: the file it resolves to, through links, and when that file was written
 * ("<command>\t<file>\t<mtime>"); "" when it is not found. Two different values: an update in between.
 */
export function programOf(command: string, path = process.env.PATH ?? ""): string {
  const tries = isAbsolute(command) || command.includes("/") ? [command] : path.split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const p of tries) {
    try {
      const file = realpathSync(p);
      const s = statSync(file);
      if (s.isFile() && s.mode & 0o111) return `${command}\t${file}\t${Math.round(s.mtimeMs)}`;
    } catch {}
  }
  return "";
}

/** The program a process started from (programOf) is not the one its command runs now. Not found then or now: not behind. */
export function programChanged(started: string | undefined, path?: string): boolean {
  if (!started) return false;
  const now = programOf(started.split("\t")[0], path);
  return !!now && now !== started;
}

/** A program's file, for the log ("…/versions/2.1.316"). */
export const programFile = (program: string | undefined) => program?.split("\t")[1] ?? "";

/** It starts: an updated Homebrew removes a library the old node needs ("Library not loaded"), and it dies on the way up. */
function runs(node: string): boolean {
  const r = spawnSync(node, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return r.error ? (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" : r.status === 0; // a slow machine is not a dead node
}

let node: { path: string; at: number; replaced?: boolean } | undefined;

/**
 * The node to start a process with: this one's (or PAGENT_NODE_BIN), unless it does not start any more, then the first on
 * PATH. A server outlives an update of node, and what it starts with its own path would all die on the way up: its
 * server functions, runners, turns. Looked at again after a minute; one that went does not come back.
 */
export function nodeBin(): string {
  if (node?.replaced || (node && Date.now() - node.at < 60_000)) return node.path;
  const own = process.env.PAGENT_NODE_BIN || process.execPath;
  if (runs(own)) return (node = { path: own, at: Date.now() }).path;
  const other = programFile(programOf("node"));
  const found = other && runs(other) ? other : "";
  if (found) console.warn(`this server's node does not start any more (${own}; updated?): starting what it starts with ${found}; restart the server to move it too`);
  else console.warn(`this server's node does not start any more (${own}; updated?), and there is no other on PATH`);
  return (node = found ? { path: found, at: Date.now(), replaced: true } : { path: own, at: Date.now() }).path;
}

/** The node a TUI's hooks and its `pagent` run with (programOf): one that is not this any more makes the TUI stale. */
export const nodeProgram = () => programOf(nodeBin());
