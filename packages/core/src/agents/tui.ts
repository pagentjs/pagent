// Turns in the agent's native TUI: starting it unattended (and its folder-trust dialog), typing a turn into it while
// following its transcript, and the command that opens it.
import type { ChildProcess } from "node:child_process";
import type { AgentDecl } from "../extract.ts";
import { askUser, pendingFor } from "../questions.ts";
import { gitRoot, keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv, throughShell } from "../shell-env.ts";
import { afterTurn, drawn, isBusy, isOpen, onTerminal, openTerminal, openTerminals, paste, pressKeys, screenLines, statusChanged, stopTerminal, terminalOf, whenClosed, whenQuiet, whenUnblocked, whenUp, type Term, type TermStatus, type TuiCommand } from "../terminal.ts";
import { keysFor, readDialog } from "./dialogs.ts";
import { driverOf } from "./driver.ts";
import { forget } from "./history.ts";
import { agentBin } from "./identity.ts";
import { agentDecl, agentInput, declOf, invoke, runnerBase, runnerScript, turnsOf } from "./runner.ts";
import { programChanged, programFile, programOf } from "../program.ts";
import { askOrDecline, chunkHandler, taken, unattended, type Push } from "./runs.ts";
import type { Ctx, Run } from "./types.ts";

/**
 * Agents whose TUI did not come up: until when their turns run headless, and why (said in the log on every try, and
 * on the page: agentStatus's `headless`). Trust is kept per git root, and what held it up (a question the user's shell
 * asked first) may be answered elsewhere meanwhile: tried again after a while (never, if the user said no to trusting
 * the folder, until the server restarts); opening its terminal by hand ends it at once.
 */
export const tuiUnavailable = new Map<string, { until: number; why: string }>();
const TUI_RETRY = Number(process.env.PAGENT_TUI_RETRY_MS) || 5 * 60_000; // tests make them short
const TUI_UP = Number(process.env.PAGENT_TUI_UP_MS) || 20_000;
const inWords = (ms: number) => (ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`);

/** Agents whose runner types turns into the TUI run in it (page = session), unless declared tui: false. */
export const runsInTui = async (decl: AgentDecl, ref: AgentRef) =>
  decl.tui !== false && (tuiUnavailable.get(keyOf(ref))?.until ?? 0) < Date.now() && (await turnsOf(decl)) === "tui";

/** Its turns run headless for now, though it has a TUI: why, and when its TUI is tried again (null: not by itself). */
export function headlessOf(ref: AgentRef): { why: string; retryAt: number | null } | null {
  const u = tuiUnavailable.get(keyOf(ref));
  if (!u || u.until < Date.now() || terminalOf(ref)) return null;
  return { why: u.why, retryAt: Number.isFinite(u.until) ? u.until : null };
}

/**
 * Start the agent's TUI in the daemon, unwatched. The first time a harness works in a folder it asks to trust it
 * (trustFolder); if the TUI does not come up, this turn and the next go headless until someone opens the terminal.
 */
export async function startTui(ctx: Ctx, ref: AgentRef): Promise<Term | null> {
  const cmd = await interactiveCommand(ctx, ref);
  const term = await openTerminal(ref, cmd, { cols: 120, rows: 40 });
  const up = await whenUp(term, TUI_UP, cmd.trust && new RegExp(cmd.trust.prompt));
  const why = up === "dialog" ? await trustFolder(ref, term, cmd) : up === "ready" ? null : await notUp(term);
  if (!why) return term;
  const key = keyOf(ref);
  const until = tuiUnavailable.get(key)?.until === Infinity ? Infinity : Date.now() + TUI_RETRY;
  tuiUnavailable.set(key, { until, why });
  const again = until === Infinity ? "until the server restarts" : `for ${inWords(TUI_RETRY)}`;
  console.warn(`the terminal of ${key} did not come up unattended: ${why}. Its turns run headless ${again}, or until its terminal is opened by hand`);
  stopTerminal(term);
  return null;
}

/** Why a TUI that was not up in time is not: it exited, or it showed something else (a question its shell asked first). */
async function notUp(term: Term): Promise<string> {
  await drawn(term);
  const shown = screenLines(term).map((l) => l.trim()).filter(Boolean).slice(-2).join(" / ");
  const showed = shown ? `; its screen showed: "${shown.length > 200 ? shown.slice(0, 199) + "…" : shown}"` : "; its screen stayed empty";
  if (!isOpen(term)) return `it exited${term.exitCode != null ? ` with ${term.exitCode}` : ""} before it was up${showed}`;
  return `it did not say it was up within ${inWords(TUI_UP)}${showed}`;
}

/**
 * The harness asks whether to trust the folder. That is the user's call, made in the harness's own dialog: whoever
 * watches the terminal answers it there; otherwise it is asked on whatever page is open, like a permission, and
 * "Trust" presses the keys that accept it. Nobody there (a trigger) or "Not now": the agent works headless (whether a
 * headless turn asks is the harness's business; the engine's runners' do not). null: it is up; else why it is not.
 */
async function trustFolder(ref: AgentRef, term: Term, cmd: TuiCommand): Promise<string | null> {
  const { trust } = cmd;
  const harness = trust?.harness ?? "The agent";
  const notTrusted = `${harness} asks to trust ${trustedDir(cmd.cwd)} first`;
  if (!trust) return notTrusted;
  if (term.viewers.size) return (await whenUp(term, 10 * 60_000)) === "ready" ? null : `${notTrusted}, and nobody answered in its terminal`;
  const answered = new AbortController(); // in the terminal, opened meanwhile
  void whenUp(term, 60 * 60_000).then(() => answered.abort());
  const r = await askOrDecline(ref, () =>
    askUser(ref, `Trust this folder for ${harness}?`, ["Trust", "Not now"], {
      kind: "permission",
      detail: `${trustedDir(cmd.cwd)}\n\n${harness} asks this the first time it works in a folder. Trusted, it can read, edit and run files here (each action still subject to its permissions).`,
      say: {
        question: { key: "ask.trust", values: { harness } },
        detail: { key: "ask.trustDetail", values: { dir: trustedDir(cmd.cwd), harness } },
        options: [{ key: "ask.trustYes" }, { key: "ask.notNow" }],
      },
      signal: answered.signal,
    }),
  );
  if (answered.signal.aborted) return (await whenUp(term, 0)) === "ready" ? null : `${notTrusted}; answered in its terminal, it did not come up`;
  answered.abort();
  if (r.declined) return `${notTrusted}, and nobody can answer (an unattended run)`;
  if (!/^trust/i.test(r.answer)) {
    tuiUnavailable.set(keyOf(ref), { until: Infinity, why: "" }); // asked again once the server restarts
    return `${notTrusted}, and you said not now`;
  }
  await pressKeys(term, trust.keys);
  return (await whenUp(term, TUI_UP)) === "ready" ? null : await notUp(term);
}

/**
 * A permission prompt in the agent's TUI that nobody answers there becomes a card on the page, like the one the harness's
 * PermissionRequest hook makes (server.ts /_pagent/permission), and its answer presses the keys its runner says answer it
 * (Claude Code: "1" Yes, Esc No). For when that hook makes none: it did not fire or failed, it timed out (an hour), or
 * someone watching the terminal left the prompt there. While the hook's card is up, that one is the card; someone
 * watching gets a minute to answer in the terminal; nobody there (a trigger's run): denied. Answered in the terminal
 * meanwhile, the card goes.
 */
const PROMPT_GRACE = 3_000; // the hook's card, if one comes, comes first
const WATCHED_GRACE = 60_000;

function watchPrompts(term: Term) {
  const keys = term.keys;
  if (!keys?.allow?.length || !keys.deny?.length) return; // its runner does not say how to answer one
  let card: AbortController | null = null;
  let timer: NodeJS.Timeout | undefined;
  const prompt = () => (isOpen(term) && term.status?.state === "blocked" && term.status.kind === "permission" ? term.status : null);
  const later = (ms: number) => (clearTimeout(timer), (timer = setTimeout(raise, ms)));
  const check = () => {
    if (prompt()) return void (card || timer || later(term.viewers.size ? WATCHED_GRACE : PROMPT_GRACE));
    clearTimeout(timer);
    timer = undefined;
    card?.abort(); // answered in the terminal
    card = null;
  };
  const raise = async () => {
    timer = undefined;
    const p = prompt();
    if (!p || card) return;
    if (pendingFor(term.ref).some((q) => q.kind === "permission")) return later(5_000); // the hook's: check again later
    const asked = (card = new AbortController());
    // What it asks, as its runner says the prompt reads (Claude Code: "approve Bash: ls -la /tmp | head -3").
    let read: RegExpExecArray | null = null;
    try {
      read = keys.prompt ? new RegExp(keys.prompt).exec(p.msg ?? "") : null;
    } catch {}
    const [, tool, what] = read ?? [];
    const r = await askOrDecline(term.ref, () =>
      askUser(term.ref, `Allow ${tool ?? "this"}?`, ["Allow", "Deny"], {
        kind: "permission",
        detail: what || p.msg || "(the prompt is in its terminal)",
        say: {
          question: tool ? { key: "ask.allow", values: { tool } } : { key: "ask.allowThis" },
          ...(what || p.msg ? {} : { detail: { key: "ask.inTerminal" } }),
          options: [{ key: "ask.allowYes" }, { key: "ask.deny" }],
        },
        signal: asked.signal,
      }),
    );
    if (asked.signal.aborted || card !== asked) return;
    card = null;
    if (prompt()) await pressKeys(term, r.declined || !/^allow/i.test(r.answer) ? keys.deny! : keys.allow!);
  };
  term.onStatus.add(check);
  check();
}
onTerminal(watchPrompts);

/**
 * Any other dialog in the agent's TUI that nobody answers there (its harness's own product prompt: Claude Code's
 * "Want to autocompact at 400k tokens instead?"; a question it asks; one it has no card for) becomes a card too, from
 * what its screen shows (dialogs.ts): its first line, its text, its choices, and Dismiss. A choice presses the keys a
 * person would (arrows to it, Enter); Dismiss its runner's dismiss keys (Esc). A card for it already (the
 * PermissionRequest hook's: a plan to approve, a question it asks that way) is the card. The same grace as a
 * permission prompt; answered in the terminal meanwhile, the card goes. Nobody can answer (an unattended run): it
 * is dismissed. Its first line is the agent's status meanwhile ("waiting in its terminal: We recommend compacting
 * earlier"), not just "dialog open".
 */
const DISMISS = "Dismiss (Esc)";
const ENTER = "Continue (Enter)";

function watchDialogs(term: Term) {
  let card: AbortController | null = null;
  let timer: NodeJS.Timeout | undefined;
  let look: NodeJS.Timeout | undefined;
  const dialog = () => isOpen(term) && term.status?.state === "blocked" && term.status.kind !== "permission";
  const later = (ms: number) => (clearTimeout(timer), (timer = setTimeout(raise, ms)));
  const read = async () => (await drawn(term), readDialog(screenLines(term)));
  // What it is about: its first line, or what its TUI says it waits on, whichever says more ("answer: Tea or coffee?
  // (Tea · Coffee)" over "☐ Beverage"; "We recommend compacting earlier" over "dialog open").
  const titleOf = (d: ReturnType<typeof readDialog>) => [d?.title, term.status?.msg].filter((s): s is string => !!s).sort((a, b) => b.length - a.length)[0] ?? "a dialog";
  const check = () => {
    if (dialog()) {
      // What it says, for its status line, once it is drawn.
      clearTimeout(look);
      look = setTimeout(() => void read().then((d) => dialog() && d && term.dialog !== titleOf(d) && ((term.dialog = titleOf(d)), statusChanged(term.ref))), 400);
      return void (card || timer || later(term.viewers.size ? WATCHED_GRACE : PROMPT_GRACE));
    }
    clearTimeout(timer);
    clearTimeout(look);
    timer = undefined;
    term.dialog = undefined;
    card?.abort(); // answered in the terminal
    card = null;
  };
  const raise = async () => {
    timer = undefined;
    if (!dialog() || card) return;
    if (pendingFor(term.ref).length) return later(5_000); // its own card (the hook's): check again later
    const d = await read();
    if (!dialog() || card) return;
    const dismiss = term.keys?.dismiss ?? ["\x1b"];
    const title = titleOf(d);
    if (unattended(term.ref)) {
      console.warn(`${keyOf(term.ref)}: dismissed a dialog in its terminal that nobody can answer (an unattended run): ${title}`);
      return void pressKeys(term, dismiss);
    }
    const asked = (card = new AbortController());
    const options = [...(d?.options.length ? d.options : [ENTER]), DISMISS];
    // Its text; its first line too when what its TUI says was the title (not the other way round: "dialog open" says nothing).
    const detail = [d && d.title !== title ? d.title : "", d?.text].filter(Boolean).join("\n\n");
    const answer = await askUser(term.ref, `Waiting in its terminal: ${title}`, options, {
      kind: "permission", // shown on any page, like a permission: the agent is stuck until someone answers
      toolKind: "dialog",
      ...(detail ? { detail } : {}),
      say: {
        question: { key: "ask.dialog", values: { title } },
        options: options.map((o) => (o === DISMISS ? { key: "ask.dismiss" } : o === ENTER ? { key: "ask.enter" } : { key: "ask.option", values: { option: o } })),
      },
      signal: asked.signal,
    });
    if (asked.signal.aborted || card !== asked) return;
    card = null;
    if (!dialog()) return;
    if (answer === DISMISS || !answer) return void pressKeys(term, dismiss);
    if (answer === ENTER) return void pressKeys(term, ["\r"]);
    // As it is now (it may have moved): the choice by its words.
    const now = await read();
    const at = now?.options.indexOf(answer) ?? -1;
    if (now && at >= 0) await pressKeys(term, keysFor(now, at));
  };
  term.onStatus.add(check);
  check();
}
onTerminal(watchDialogs);

/** What a harness trusts: the git repository the folder is in (the whole app), else the folder itself. */
function trustedDir(dir: string): string {
  return gitRoot(dir) ?? dir;
}

/**
 * One turn typed into the TUI: wait until it is not in a turn, follow its transcript (the runner's "follow" op)
 * from just before the message is pasted, and end with the turn — the transcript's end of turn, or the TUI back
 * to idle without one (an interrupted turn), or gone. null: the TUI exited before the message was typed (it is not
 * the agent's terminal any more; the caller starts another). `now`: typed into the turn in progress (tuiInterject),
 * which then is the turn followed.
 */
export async function tuiTurn(term: Term, script: string, base: Record<string, unknown>, message: string, run: Run, push: Push, now = false): Promise<string | null> {
  if (!(await (now ? whenUnblocked(term) : whenQuiet(term)))) return null;
  let text = "";
  let child: ChildProcess | undefined;
  let marked = false;
  let heard = false; // anything of the turn in its transcript
  let onMark = () => {};
  const mark = new Promise<void>((r) => (onMark = r));
  const forward = chunkHandler(run, push, (t) => (text = t));
  const f: Following = { term, end: () => child?.kill(), waiting: [], joined: [] };
  const followed = invoke(script, { op: "follow", ...base, ...(term.pid ? { tui: term.pid } : {}) }, String(base.cwd), (c) => {
    if (c.type === "mark") return void ((marked = true), onMark());
    if (!marked) return;
    if (c.type !== "start") heard = true;
    if (c.type === "taken") return join(f, String(c.text ?? ""), c.id);
    forward(c);
    for (const j of f.joined) j.forward(c);
  }, (c) => (child = c));
  await Promise.race([mark, followed]);
  if (!marked) throw new Error("the runner could not follow the agent's terminal (its follow op ended first), so the message was not typed");
  if (!isOpen(term)) return (child?.kill(), null);
  if (run.stopped) return (child?.kill(), ""); // stopped before it began: not typed
  const key = keyOf(run.ref);
  following.set(key, f);
  await paste(term, message);
  taken(run);
  const stop = afterTurn(term, () => setTimeout(f.end, 3000));
  // Typed into a TUI in a turn (now), it waits in its queue for as long as that turn takes: not watched.
  let untaken = "";
  const watch = now ? () => {} : whenNotTaken(term, key, () => heard, (why) => ((untaken = why), f.end()));
  await followed;
  stop();
  watch();
  if (following.get(key) === f) following.delete(key);
  for (const j of f.joined) j.resolve(j.text);
  // Typed, but the turn ended before it took them in (it began the next one meanwhile, or they went back into its
  // prompt): their reply, if any, reaches the conversation from the transcript, as a turn typed there does.
  for (const j of f.waiting) j.push({ type: "start" }), j.push({ type: "finish" }), j.resolve("");
  if (untaken) push({ type: "error", errorText: untaken });
  return untaken || text;
}

/**
 * A message typed into an idle TUI that it never took (SPEC 13.25: the paste sat in its prompt, the Enter after it was
 * lost, and nothing ended the turn followed: an hour "starting", the messages after it waiting). Taken, it starts a
 * turn: its TUI says it works, or its transcript has some of it. Neither, TAKE_WAIT after it was typed and the TUI
 * idle: Enter once more (the message still in its prompt goes in, once; an empty prompt does nothing). Neither as long
 * again: `give` ends the run, saying why, and the messages after it go on. Returns what stops watching.
 */
const TAKE_WAIT = Number(process.env.PAGENT_TUI_TAKE_MS) || 60_000; // tests make it short

function whenNotTaken(term: Term, key: string, heard: () => boolean, give: (why: string) => void): () => void {
  let worked = false;
  let done = false;
  const onStatus = (s: TermStatus) => void (isBusy(s.state) && (worked = true));
  term.onStatus.add(onStatus);
  const notIn = () => !done && !worked && !heard() && isOpen(term) && !isBusy(term.status?.state);
  let timer = setTimeout(async () => {
    if (!notIn()) return;
    console.warn(`${key}: its terminal started no turn ${inWords(TAKE_WAIT)} after a message was typed into it (it may sit in its prompt): pressing Enter again`);
    await pressKeys(term, ["\r"]);
    if (done) return;
    timer = setTimeout(() => {
      if (!notIn()) return;
      const why = `its terminal did not take the message: no turn started in it ${inWords(2 * TAKE_WAIT)} after it was typed, nor after Enter was pressed again (the message may still be in its prompt)`;
      console.warn(`${key}: ${why}; the messages after it go on`);
      give(why);
    }, TAKE_WAIT);
  }, TAKE_WAIT);
  return () => ((done = true), clearTimeout(timer), term.onStatus.delete(onStatus));
}

/** A run whose message was typed into the turn in progress: it follows that turn from where it was taken in. */
type Joined = { run: Run; push: Push; message: string; forward: (c: any) => void; text: string; resolve: (text: string) => void };

/** The turn followed in an agent's TUI now: its run, and the runs whose messages were typed into it meanwhile. */
type Following = { term: Term; end: () => void; waiting: Joined[]; joined: Joined[] };
const following = new Map<string, Following>();

/**
 * The TUI took a message typed during the turn in: its run joins the turn (by its text, else the one typed first). id:
 * the transcript's for it, when the runner knows it (ids.ts).
 */
function join(f: Following, text: string, id?: unknown) {
  const at = f.waiting.findIndex((j) => j.message.trim() === text.trim());
  const [j] = f.waiting.splice(at < 0 ? 0 : at, 1);
  if (!j) return; // the turn's own message (typed into a busy TUI), or one a person typed there
  if (typeof id === "string" && id) j.run.historyId = id;
  j.push({ type: "start" });
  f.joined.push(j);
}

/**
 * A message into the turn in progress (an interjection): typed into the busy TUI now, never into a prompt it shows.
 * The harness takes it in between two tool calls (or, none left, as the next turn, followed too). Its run joins the
 * turn the app follows there, from where it was taken in, and ends with it; with none followed (a turn the app did
 * not start), it follows that turn itself. null: the TUI exited.
 */
export async function tuiInterject(term: Term, script: string, base: Record<string, unknown>, message: string, run: Run, push: Push): Promise<string | null> {
  const key = keyOf(run.ref);
  if (!following.get(key)) return tuiTurn(term, script, base, message, run, push, true);
  if (!(await whenUnblocked(term))) return null;
  const f = following.get(key);
  if (!f || f.term !== term) return tuiTurn(term, script, base, message, run, push, true); // it ended meanwhile
  if (run.stopped) return "";
  return new Promise<string>((resolve) => {
    const j: Joined = { run, push, message, forward: chunkHandler(run, push, (t) => (j.text = t)), text: "", resolve };
    f.waiting.push(j);
    void paste(term, message).then(() => taken(run));
  });
}

/** Stop following the agent's turn in its TUI (one that would not end by itself): its run ends. */
export function endFollow(ref: AgentRef): boolean {
  const f = following.get(keyOf(ref));
  f?.end();
  return !!f;
}

/** Can a message go into the agent's turn in progress now (its TUI is in one)? */
export const tuiInterjects = (ref: AgentRef) => {
  const t = terminalOf(ref);
  return !!t && isBusy(t.status?.state);
};

/**
 * The agent's native TUI on its session (or a fork of it), with the same additions as its headless runs. Its driver
 * says what else it needs (a TUI on a shared thread attaches to the one the agent's session opened, and goes with it).
 */
export async function interactiveCommand(ctx: Ctx, ref: AgentRef, fork = false): Promise<TuiCommand> {
  const decl = await agentDecl(ctx, ref);
  const base = runnerBase(ctx, ref, decl);
  const bound = await (await driverOf(decl)).tui(ctx, ref);
  if (fork) forget(ref);
  let cmd: TuiCommand | null = null;
  const env = await harnessEnv();
  // The TUI is the agent itself, not a side door: the same system prompt, identity and skills as its headless turns.
  // What it runs is kept with it (program.ts): an update of its harness makes it stale.
  await invoke(runnerScript(decl.runner), { op: "interactive", ...base, ...bound.input, fork, ...(await agentInput(ctx, ref, decl)) }, base.cwd, (e) => {
    if (e.type !== "command") return;
    cmd = { command: e.command, args: e.args, cwd: e.cwd, env: e.env, trust: e.trust, keys: { ...e.keys, ...(typeof e.prompt === "string" ? { prompt: e.prompt } : {}) }, ...(bound.session ? { session: bound.session } : {}), decl: declSignature(decl), program: programOf(e.command, e.env?.PATH ?? env.PATH) };
  });
  if (!cmd) throw new Error(`runner ${decl.runner} has no interactive mode`);
  // `shell: true`: started through the user's login shell, so their function or alias for the CLI applies.
  if (decl.shell === true) {
    const shell = throughShell(cmd, { ...env, ...(cmd as TuiCommand).env }, agentBin());
    Object.assign(cmd, shell, { env: { ...(cmd as TuiCommand).env, ...shell.env } });
  }
  return cmd;
}

/**
 * What of an agent's declaration its TUI starts with: all of it but what only the engine reads (how long its
 * terminal stays, whether it answers strangers). Changed since its TUI started (a settings page wrote another model),
 * that TUI is stale (tuiStale): restarted before the agent's next message unless someone is in it, and the page says so.
 */
export function declSignature(decl: AgentDecl): string {
  const { resident: _r, strangers: _s, ...rest } = decl;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
}

/**
 * Restart the agent's TUI, on its session, to take its declaration as it is now: not during a turn. Whoever watches it
 * reconnects to the new one at once; nobody watching, the next message starts it.
 */
export async function restartTerminal(ref: AgentRef): Promise<string> {
  const term = terminalOf(ref);
  if (!term) return "its terminal is not open; the next one starts with its declaration as it is";
  if (isBusy(term.status?.state)) throw new Error("it is in a turn (or a prompt in its terminal waits): restart its terminal once that is over");
  console.log(`restarting the terminal of ${keyOf(ref)} (asked to)`);
  stopTerminal(term, true);
  await whenClosed(term);
  return "restarted its terminal";
}

/**
 * Why its TUI is stale: started with a declaration that is not the agent's any more ("settings", declSignature), or
 * on a harness updated since ("update", program.ts; one started before its program was kept counts as that, so it is
 * brought up to date once); false: it is not.
 */
export async function tuiStale(ctx: Ctx, ref: AgentRef, term = terminalOf(ref)): Promise<"settings" | "update" | false> {
  if (!term) return false;
  const decl = await declOf(ctx, ref).catch(() => undefined);
  if (!decl) return false;
  if (term.decl && (await turnsOf(decl)) === "tui" && declSignature(decl) !== term.decl) return "settings";
  return term.program === undefined || programChanged(term.program, (await harnessEnv()).PATH) ? "update" : false;
}

const REFRESH_QUIET = Number(process.env.PAGENT_TUI_REFRESH_MS) || 60_000; // tests make it short
const refreshing = new Set<string>();

/**
 * The TUIs nobody is in that are stale (tuiStale), quiet for a minute, start again on their session with what is
 * current: checked every minute, so an update of a harness reaches every agent by itself. One whose turns run in its
 * TUI comes back at once (the next message would start it anyway); any other the next time someone opens it.
 */
export async function refreshTuis(ctx: Ctx) {
  for (const term of openTerminals()) {
    const key = keyOf(term.ref);
    const idle = () => isOpen(term) && !term.viewers.size && !isBusy(term.status?.state) && !term.dialog && Date.now() - term.quietSince >= REFRESH_QUIET;
    if (refreshing.has(key) || !idle()) continue;
    const why = await tuiStale(ctx, term.ref, term).catch(() => false as const);
    if (!why || !idle()) continue;
    refreshing.add(key);
    try {
      const was = programFile(term.program);
      console.log(`restarting the terminal of ${key}: ${why === "update" ? `its harness was updated since it started (${was || "its version was not kept"})` : "its declaration changed since it started"}`);
      stopTerminal(term, true);
      await whenClosed(term);
      if (!terminalOf(term.ref) && (await runsInTui(await agentDecl(ctx, term.ref), term.ref))) await startTui(ctx, term.ref);
    } catch (e) {
      console.warn(`${key}: its terminal did not come back (${(e as Error).message}); the next message starts it`);
    } finally {
      refreshing.delete(key);
    }
  }
}
