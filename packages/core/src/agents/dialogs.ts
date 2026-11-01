// A dialog in an agent's TUI, read off its screen (terminal.ts screenLines): a TUI that waits on one (OSC 7501
// `blocked`) that is no permission prompt says only that it is open ("dialog open"), not what it asks. Claude Code
// puts up its own product prompts this way ("Want to autocompact at 400k tokens instead?"), and a question it asks
// (AskUserQuestion); nobody watching its terminal, it waits for hours (agents/tui.ts makes it a card).
//
// What a TUI of this kind draws (Ink, ratatui): a rule, the dialog's text, its choices one per line with a marker at the
// one selected ("❯ 1. Yes" / "  2. No", numbered or not, a deeper line under one its description), and a line saying
// which keys do what. Its choices are made the way a person makes them: arrow keys to the one wanted, then Enter.

export type Dialog = {
  /** Its first line ("We recommend compacting earlier"). */
  title: string;
  /** The rest of what it says, the keys line at its end included. */
  text: string;
  /** Its choices, as they read (without the marker, the number, a description beside it). */
  options: string[];
  /** The choice selected now (the marker's). */
  selected: number;
};

const MARK = /^(\s*)[❯›▸▶]\s+(\S.*)$/;
const RULE = /^\s*[╭╰┌└]?[─━═╌]{6,}[╮╯┐┘]?\s*$/;
const NUMBERED = /^\d+[.)]\s+/;

const indent = (l: string) => l.length - l.trimStart().length;
const isRule = (l: string) => RULE.test(l);

/** Its choice as it reads: no marker, no number, no tick, no description beside it (two spaces or more apart). */
const label = (l: string) =>
  l
    .trim()
    .replace(/^[❯›▸▶]\s+/, "")
    .replace(NUMBERED, "")
    .split(/\s{2,}/)[0]
    .replace(/\s*[✔✓]$/, "")
    .trim();

/**
 * The dialog the screen shows at its bottom, or null (no choice marked). Lines inside a box ("│ … │") are read
 * without its sides.
 */
export function readDialog(screen: string[]): Dialog | null {
  const lines = screen.map((l) => l.replace(/^(\s*)│/, "$1 ").replace(/\s*│\s*$/, ""));
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (MARK.test(lines[i])) at = i;
  if (at < 0) return null;
  const [, , first] = MARK.exec(lines[at])!;
  const col = lines[at].indexOf(first); // where a choice's words start
  const numbered = NUMBERED.test(first);
  // A choice: its words where the marked one's start, numbered as it is. Numbered choices may have rules, blank lines
  // and descriptions (deeper lines) between them; others are one line each, one under the other.
  const words = (l: string) => l.trim().replace(/^[❯›▸▶]\s+/, "");
  const choiceAt = (i: number) => {
    const l = lines[i];
    const starts = MARK.test(l) ? l.indexOf(MARK.exec(l)![2]) : indent(l);
    return starts === col && !!l.trim() && NUMBERED.test(words(l)) === numbered;
  };
  const between = (l: string) => numbered && (!l.trim() || isRule(l) || indent(l) > col);
  const choices = [at];
  for (let i = at - 1; i >= 0; i--) {
    if (choiceAt(i)) choices.unshift(i);
    else if (!between(lines[i])) break;
  }
  for (let i = at + 1; i < lines.length; i++) {
    if (choiceAt(i)) choices.push(i);
    else if (!between(lines[i])) break;
  }
  // Its text: from the rule above its choices (where it starts) down to them; the keys line after them.
  let top = choices[0];
  while (top > 0 && !isRule(lines[top - 1]) && choices[0] - top < 30) top--;
  const text = (from: number, to: number) => lines.slice(from, to).map((l) => l.trim()).filter((l) => l && !isRule(l));
  const body = text(top, choices[0]);
  const after = text(choices[choices.length - 1] + 1, lines.length);
  const seen = new Map<string, number>();
  const options = choices.map((i) => {
    const l = label(lines[i]) || lines[i].trim();
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n > 1 ? `${l} (${n})` : l;
  });
  const [title = options[choices.indexOf(at)] ?? "a dialog", ...rest] = body;
  return { title, text: [...rest, ...after].join("\n"), options, selected: choices.indexOf(at) };
}

/** The keys that make a choice from the one selected now: arrows to it, then Enter. */
export function keysFor(d: Dialog, choice: number): string[] {
  const steps = choice - d.selected;
  return [...Array(Math.abs(steps)).fill(steps > 0 ? "\x1b[B" : "\x1b[A"), "\r"];
}
