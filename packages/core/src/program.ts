// Which program a command runs: a harness updated since one of its processes started (Claude Code's own updater moves
// its link to a new version, Homebrew to a new Caskroom folder, npm writes the same path again) runs something else
// now, so that process is behind (agents/tui.ts restarts such a TUI, agents/thread.ts such a service).
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
