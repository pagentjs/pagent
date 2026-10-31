// A page's badge: what its row in the rail says after its title, set by the app's server code (badge() from
// "pagent/server"): a count ("64"), a count that wants the user ("4" on a pill), or a dot for something new. It is
// what the app knows at run time, so it is no declaration (metadata.icon is): the engine keeps it in the node's own
// state (<node>/.state/badge.json), which moves with the node (`pagent mv`), goes with an instance that is removed,
// survives a restart and gives git nothing. Open shells hear of each change (a "badge" event) and redraw the row.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { broadcast } from "./events.ts";
import { canonical, nodeDir, normPath, notMade, resolveRoute } from "./tree.ts";

/**
 * tone: "attention", the user is wanted (a pill); "quiet", only a count (faint, the default); "new", something new (a
 * dot, and the count, if any, in the accent). count: none for a dot alone.
 */
export type Badge = { count?: number; tone: BadgeTone };
export type BadgeTone = "attention" | "quiet" | "new";
const TONES: BadgeTone[] = ["attention", "quiet", "new"];

const fileOf = (root: string, path: string) => join(nodeDir(root, path), ".state", "badge.json");

/** The page's badge, or null (none, or a file that does not read: no badge rather than a broken row). */
export function badgeOf(root: string, path: string): Badge | null {
  try {
    const b = JSON.parse(readFileSync(fileOf(root, path), "utf8")) as Partial<Badge>;
    if (!TONES.includes(b.tone as BadgeTone)) return null;
    return { ...(typeof b.count === "number" ? { count: b.count } : {}), tone: b.tone as BadgeTone };
  } catch {
    return null;
  }
}

/**
 * Set a page's badge (count: a whole number, 0 or more; null or 0: no count), or clear it (no count, and not "new").
 * path: the page, as the engine or people write it (/studio/demo/修登录). Throws, saying why, for a path that is no
 * page of the rail (a fork, an instance not made, a folder without a page) and for a count or tone that is not one.
 */
export function setBadge(root: string, pathArg: string, count: unknown, toneArg: unknown = "quiet"): { path: string; badge: Badge | null } {
  const path = canonical(root, normPath(pathArg));
  if (path.includes("/.mounts")) throw new Error(`${path} is an instance of an imported node, which the rail does not list: a badge goes on a page`);
  if (!resolveRoute(root, path) || notMade(root, path)) throw new Error(`no page at ${path}: a badge goes on a page the rail lists`);
  if (count !== null && count !== undefined && !(typeof count === "number" && Number.isInteger(count) && count >= 0)) throw new Error(`a badge's count is a whole number, 0 or more (or null: none), not ${JSON.stringify(count)}`);
  if (!TONES.includes(toneArg as BadgeTone)) throw new Error(`a badge's tone is "attention" (the user is wanted), "quiet" (a count) or "new" (a dot), not ${JSON.stringify(toneArg)}`);
  const tone = toneArg as BadgeTone;
  // 0 is no count, so server code can pass its count as it is; "new" is a dot even without one.
  const badge: Badge | null = typeof count === "number" && count > 0 ? { count, tone } : tone === "new" ? { tone } : null;
  const file = fileOf(root, path);
  if (!badge) rmSync(file, { force: true });
  else {
    mkdirSync(join(file, ".."), { recursive: true });
    // Replace, never truncate in place: the rail never reads half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(badge) + "\n");
    renameSync(tmp, file);
  }
  broadcast({ type: "badge", path, badge });
  return { path, badge };
}
