// Light or dark, as a reader preference, the way the language is one (i18n.ts): the reader's choice (setTheme: one of
// the person's settings, the same in every app of theirs: settings.ts), else the system's (prefers-color-scheme). The
// shell's tokens (--pagent-*) have a light and a dark value, and data-theme on <html> picks one (without it, they follow
// the system), so the shell (rail, top bar), every page in it and the terminal turn together. The shell's index.html
// sets it before anything paints, from what this browser last heard the setting was.
import { useSyncExternalStore } from "react";
import { setSetting, settingsNow, subscribeSettings } from "./settings.ts";

export type Theme = "light" | "dark";

const browser = typeof window !== "undefined";
const dark = browser && typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const system = (): Theme => (dark?.matches ? "dark" : "light");

let chosen = settingsNow().theme;
let theme: Theme = chosen ?? system();
let told = chosen; // the choice components last heard of (useTheme({ chosen: true }))
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));

/** data-theme on the document: the choice, or none (the tokens follow the system). */
function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (chosen) root.dataset.theme = chosen;
  else delete root.dataset.theme;
}

function update() {
  chosen = settingsNow().theme;
  apply();
  const next = chosen ?? system();
  if (next === theme && told === chosen) return;
  theme = next;
  told = chosen;
  for (const l of listeners) l();
}

apply();
dark?.addEventListener("change", update);
subscribeSettings(update); // chosen on this page, in another tab, in another app

/**
 * The reader picks light or dark: the shell and every page follow it, in every app of theirs (it is one of their
 * settings: setSetting("theme")). null: the system's again.
 */
export function setTheme(next: Theme | null): Promise<void> {
  return setSetting("theme", next === "light" || next === "dark" ? next : null);
}

/**
 * The theme the app is shown in now: the reader's choice, else the system's. A component that calls this renders again
 * when it changes (a canvas, a chart, a code view that picks its own colors; pages that use the tokens need nothing).
 * { chosen: true }: the reader's choice alone (null: the system's), for a settings page that shows what was picked.
 */
export function useTheme(): Theme;
export function useTheme(opts: { chosen: true }): Theme | null;
export function useTheme(opts?: { chosen: true }): Theme | null {
  const get = opts?.chosen ? () => told : () => theme;
  return useSyncExternalStore(subscribe, get, get);
}
