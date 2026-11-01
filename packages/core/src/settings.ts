// The person's settings (SPEC 13.15): one file for the whole machine, <PAGENT_HOME>/settings.json, shared by every
// pagent app they run (each its own server and port, so its own origin: what a browser remembers is one app's alone).
// The language and the theme the apps are read in, the harness a new agent runs; one more is one more row of SETTINGS.
//
// Each app server serves it (GET / PUT /_pagent/settings: the browser's plane, the owner's alone), watches the file
// and tells its pages of a change on the event stream, so every open tab of every app follows. Server code reads it
// with settings() ("pagent/server"); agents declared without a cli run its harness (pinHarness).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonPaths } from "./daemon-protocol.ts";
import { engine } from "./engine.ts";

/** A setting: its value when the file does not say (or says something it does not take), and what it takes. */
type Setting<T> = { default: T; valid: (v: unknown) => v is T; takes: string };

const setting = <T>(s: Setting<T>) => s;

/** The settings there are. A key the file has that is none of these (a newer pagent's) is kept as it is, never read. */
export const SETTINGS = {
  // The language every app is read in (a tag: "zh-CN"); null: each app's own (its metadata.lang), else the browser's.
  lang: setting<string | null>({ default: null, valid: (v): v is string | null => v === null || (typeof v === "string" && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(v)), takes: 'a language tag ("zh-CN", "en") or null' }),
  // Light or dark; null: the system's.
  theme: setting<"light" | "dark" | null>({ default: null, valid: (v): v is "light" | "dark" | null => v === null || v === "light" || v === "dark", takes: '"light", "dark" or null' }),
  // What an agent declared without a cli runs, from its first turn on (a new session of the studio, too): one of the
  // engine's runners, each a harness (SPEC 13.18; GET /_pagent/settings lists them, with what people call them).
  harness: setting<string>({
    default: "claude",
    valid: (v): v is string => typeof v === "string" && engine.runners().includes(v),
    get takes() {
      return `one of the harnesses: ${engine.runners().map((h) => `"${h}"`).join(", ")}`;
    },
  }),
};

export type Settings = { [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K]["default"] };
const KEYS = Object.keys(SETTINGS) as (keyof Settings)[];

export const settingsFile = () => join(daemonPaths().home, "settings.json");

// The file as last read, kept in memory: every declaration and status asks for the default harness, so the file is
// read again only when its stamp changed (one stat, not a read and a parse). A file that does not read (a write by hand
// cut short, a stray comma) leaves the last good one in force: the apps do not fall back to the defaults, the watcher
// tells them of nothing, and a write is refused (writeSettings) rather than replacing the person's file with one key.
type Read = { stamp: string; raw: Record<string, unknown>; settings: Settings; broken: string | null };
let kept: Read | null = null;

const stampOf = (file: string): string => {
  try {
    const s = statSync(file);
    return `${file}:${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return `${file}:none`;
  }
};

const settingsIn = (r: Record<string, unknown>): Settings => Object.fromEntries(KEYS.map((k) => [k, SETTINGS[k].valid(r[k]) ? r[k] : SETTINGS[k].default])) as Settings;

/** The file now: what it says (an object), {} when it is not there; one that does not read is `broken`, with the last good. */
function load(): Read {
  const file = settingsFile();
  const stamp = stampOf(file);
  if (kept?.stamp === stamp) return kept;
  const good = (raw: Record<string, unknown>): Read => (kept = { stamp, raw, settings: settingsIn(raw), broken: null });
  const broken = (why: string): Read => (kept = { stamp, raw: kept?.raw ?? {}, settings: kept?.settings ?? settingsIn({}), broken: why });
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? good({}) : broken(`cannot read ${file} (${(e as Error).message})`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return broken(`${file} is not JSON (${(e as Error).message})`);
  }
  return v && typeof v === "object" && !Array.isArray(v) ? good(v as Record<string, unknown>) : broken(`${file} is not { key: value }`);
}

/** Why the file does not read now (the settings in force are the last good ones), or null. */
export const settingsBroken = (): string | null => load().broken;

/** The settings now: each the file's, when it says one the setting takes, else its default (the last good file's). */
export function readSettings(): Settings {
  return { ...load().settings };
}

/** The settings file is there but does not read: it is not written over. */
export class SettingsBroken extends Error {}

/** Why `patch` cannot be written (a key that is no setting, a value it does not take), or null. */
export function settingsError(patch: unknown): string | null {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "settings are { key: value }";
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(SETTINGS, k)) return `no setting "${k}" (there are ${KEYS.join(", ")})`;
    const s = SETTINGS[k as keyof Settings] as Setting<unknown>;
    if (v !== null && !s.valid(v)) return `${k} is ${s.takes}`;
  }
  return null;
}

/**
 * Change some settings: { key: value }, null for its default (the key leaves the file). The rest of the file stays as
 * it is (keys this pagent does not know among it). Written whole (a temporary file renamed over it), so a reader never
 * sees half of it. The settings after. A file that does not read is never written over (SettingsBroken): the person
 * fixes it, or removes it, first; nothing of theirs is lost.
 */
export function writeSettings(patch: Record<string, unknown>): Settings {
  const no = settingsError(patch);
  if (no) throw new Error(no);
  const now = load();
  if (now.broken) throw new SettingsBroken(`${now.broken}: fix it or remove it, then change the setting again (nothing was written)`);
  const next = { ...now.raw };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return readSettings();
}

/**
 * Which change of the settings this server saw last: higher is newer. A page hears of them by more than one way (the
 * response to its read, to its write, the event stream), in any order, and keeps the newest (bridge: settings.ts). From
 * the clock, so a server started again goes on from above what its pages heard from the one before.
 */
let rev = Date.now();

/**
 * Call `cb` with the settings each time they change: written by this server, another app's, or by hand. Each change
 * once (a write here and the watcher's sight of it are the same change), with its rev. A file that does not read changes
 * nothing: the last good settings stay in force, and nothing is told until it reads again. `changed`: settings this
 * server read or wrote; their rev.
 */
export function watchSettings(cb: (s: Settings, rev: number) => void): { changed: (s: Settings) => number } {
  let last = JSON.stringify(readSettings());
  const changed = (s: Settings) => {
    const now = JSON.stringify(s);
    if (now === last) return rev;
    last = now;
    rev = Math.max(rev + 1, Date.now());
    cb(s, rev);
    return rev;
  };
  // The folder, not the file: it may not be there yet, and a write renames a new file over it.
  const dir = dirname(settingsFile());
  mkdirSync(dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(dir, (_e, name) => {
      if (name !== "settings.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => changed(readSettings()), 30);
    })
      .on("error", () => {})
      .unref(); // it never keeps a process alive (the server has its socket for that)
  } catch (e) {
    console.warn(`settings: cannot watch ${dir} (${(e as Error).message}); a change made elsewhere shows here after a reload`);
  }
  return { changed };
}

// ---------------------------------------------------------------- the default harness

/** Where an agent declared without a cli keeps the harness it took: in its state, so it goes with its folder. */
const pinFile = (dir: string, agent: string) => join(dir, ".state", agent, "harness.json");

/**
 * The harness of an agent declared without a cli (its node's folder `dir`): the one its session is on, else the
 * default now (it has no conversation yet, so nothing is lost by following the default).
 */
export function harnessOf(dir: string, agent: string): Settings["harness"] {
  try {
    const h = JSON.parse(readFileSync(pinFile(dir, agent), "utf8"))?.harness;
    if (SETTINGS.harness.valid(h)) return h;
  } catch {}
  return readSettings().harness;
}

/**
 * Once such an agent really has a session (its runner said which, or a turn of it ended well: agents/runs.ts at a
 * run's end, agents/thread.ts when its thread is ready), the harness it is on becomes its own, as a conversation cannot move to another harness. So changing
 * the default never moves an agent that has talked, and always moves one that has not (a turn that failed, a terminal
 * opened and left, a stranger answered: none of them made a session). "wx": two at once write it once.
 */
export function pinHarness(dir: string, agent: string, harness: string): void {
  const file = pinFile(dir, agent);
  if (existsSync(file) || !existsSync(dir) || !SETTINGS.harness.valid(harness)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ harness }) + "\n", { flag: "wx" });
  } catch {}
}
