// The person's settings (SPEC 13.15): one file for the whole machine, shared by every pagent app they run, which each
// app's server serves and watches (core: settings.ts, the other end of this, which says what each takes). The shell
// reads them when it starts and hears every change on its event stream, so every open tab of every app follows a
// change made in any of them. The language and the theme are two of them (i18n.ts, theme.ts); a page reads them all
// with useSettings() and changes one with setSetting().
//
// What they are when the page starts: what its server put in it (window.__PAGENT_SETTINGS__: the shell's index.html
// applies the theme from it before anything runs), else (a page its server did not make: vite's, in development) the
// last ones this browser was told, which it keeps for that; the file is what they are.
//
// Each change the server tells has its rev (core: settings.ts), and they reach a page by more than one way, in any
// order (the response to its read, to its write, the event stream): only a newer one is taken. A change made here shows
// at once, over what the server says, until the server has answered; refused, that setting is as the server says now.
import { useSyncExternalStore } from "react";

export type Settings = {
  /** The language every app is read in ("zh-CN"); null: each app's own (its metadata.lang), else the browser's. */
  lang: string | null;
  /** Light or dark; null: the system's. */
  theme: "light" | "dark" | null;
  /**
   * What an agent declared without a cli runs, from its first turn on; what a new session of an app defaults to: one of
   * `harnesses`.
   */
  harness: string;
  /** The harnesses there are (the engine's runners, each as it names its harness): what `harness` and `cli` take. Read only. */
  harnesses?: { id: string; title: string }[];
};

const DEFAULTS: Settings = { lang: null, theme: null, harness: "claude" };
const CACHE = "pagent.settings";
const browser = typeof window !== "undefined";

/** The settings as a server says them: which change they are (rev), the list of harnesses when it was asked for. */
export type SettingsFromServer = Partial<Settings> & { rev?: number };

/** What the page came with (its server's), else what this browser last heard. */
function first(): SettingsFromServer {
  try {
    const inline = browser ? (window as { __PAGENT_SETTINGS__?: unknown }).__PAGENT_SETTINGS__ : null;
    const v = inline ?? (browser ? JSON.parse(localStorage.getItem(CACHE) ?? "null") : null);
    return v && typeof v === "object" ? (v as SettingsFromServer) : {};
  } catch {
    return {};
  }
}

const strip = ({ rev: _, ...s }: SettingsFromServer): Partial<Settings> => s;
const start = first();
/** The newest the server said (its rev: -1, none yet), and the changes made here it has not answered (by setting). */
let server: Settings = { ...DEFAULTS, ...strip(start) };
let serverRev = typeof start.rev === "number" ? start.rev : -1;
const pending = new Map<keyof Settings, { value: unknown; n: number }>();
let writes = 0;
let current: Settings = server;
let write: ((patch: Partial<Record<keyof Settings, unknown>>) => Promise<SettingsFromServer>) | null = null;
const listeners = new Set<() => void>();

/** Called (for i18n.ts, theme.ts and useSettings) whenever the settings change. */
export const subscribeSettings = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));
/** The settings now. */
export const settingsNow = (): Settings => current;

/** What shows: the server's, with the changes made here it has not answered yet over them. */
function show() {
  const next = { ...server, ...Object.fromEntries([...pending].map(([k, p]) => [k, p.value])) } as Settings;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try {
    if (browser) localStorage.setItem(CACHE, JSON.stringify(current));
  } catch {}
  for (const l of listeners) l();
}

/**
 * For the host: the settings as its server says them (when it starts, at each change, made in any app, and in answer to
 * a write), and how a change is written (to that server, which writes the file every app reads). One older than what
 * the page has (its rev) is left out: it arrived late.
 */
export function receiveSettings({ rev, ...settings }: SettingsFromServer) {
  // The list of harnesses comes when the shell reads them, not with each change: kept, and taken whenever it comes.
  const harnesses = settings.harnesses ?? server.harnesses;
  if (rev !== undefined && rev < serverRev) {
    if (settings.harnesses) server = { ...server, harnesses };
  } else {
    if (rev !== undefined) serverRev = rev;
    server = { ...DEFAULTS, ...(harnesses ? { harnesses } : {}), ...settings };
  }
  show();
}
export function provideSettingsWriter(fn: typeof write) {
  write = fn;
}

/**
 * Change one of the person's settings, for every app of theirs: this page and the shell follow at once, every other open
 * tab of any app as soon as its server sees the file change. null: its default. Rejects when the server refuses it, and
 * the setting is then as the server says (the others as they are: changed meanwhile in another tab, they stay so).
 */
export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K] | null): Promise<void> {
  const n = ++writes;
  pending.set(key, { value: value ?? DEFAULTS[key], n });
  show();
  if (!write) {
    // No host (a test): only here.
    pending.delete(key);
    server = { ...server, [key]: value ?? DEFAULTS[key] };
    return show();
  }
  try {
    receiveSettings(await write({ [key]: value }));
  } finally {
    // The last change made here to this setting answered (a later one still waits: it shows until it is).
    if (pending.get(key)?.n === n) pending.delete(key);
    show();
  }
}

/**
 * The person's settings, the same in every app of theirs (lang, theme, harness). A component that calls this renders
 * again when one changes, wherever it was changed.
 */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, settingsNow, settingsNow);
}
