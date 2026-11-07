// Runs: a message to an agent becomes a run, written down first (the inbox), delivered by the agent's session driver
// (driver.ts), followed by any viewer, and ended: what it reports back (a delegation), what it leaves for the next
// server (a message that did not arrive). Runs wait for each other when the driver says so (the agent is an actor).
import { randomUUID } from "node:crypto";
import type { UIMessage, UIMessageChunk } from "ai";
import { callerLine, parseLine, type Caller } from "../caller.ts";
import { broadcast } from "../events.ts";
import { postOut } from "../outside.ts";
import { drop, keep, letters, type MessageLetter } from "../inbox.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { notMade } from "../tree.ts";
import type { AgentDecl } from "../extract.ts";
import { driverFor, driverOf, drivers, type SessionDriver } from "./driver.ts";
import { refreshTuis } from "./tui.ts";
import { forget, watchAfter } from "./history.ts";
import { appIdMap, noteRun } from "./ids.ts";
import { answered } from "./remote.ts";
import { agentDecl, declOf, nodeFolder, runnerScript } from "./runner.ts";
import { pinHarness } from "../settings.ts";
import { noteStuck, subagentActivity, subagentDoing, toolActivity, toolDoing, type Activity, type SubagentLine } from "./status.ts";
import type { AskInput, Conflict, Ctx, ReplyPost, Run, SessionInfo } from "./types.ts";

/** The message reached the agent's harness: its letter can go. */
export function taken(run: Run) {
  if (run.taken) return;
  run.taken = true;
  run.letter?.taken();
}

// Runs this server knows by id that it did not start itself (taken up from the daemon): a letter with one of these ids
// was delivered before the server stopped.
export const known = new Set<string>();

const queues = new Map<string, Promise<unknown>>();
const open = new Map<string, number>(); // agent → its runs scheduled and not ended: a queued one with any before it waits
// agent → its queued runs that wait for their turn, oldest first: what its status shows, and what a person may withdraw
const waiting = new Map<string, Run[]>();
export const sessions = new Map<string, SessionInfo>(); // agent → what its harness reported at the start of the last turn
// agent → its session's token use, as its runner said at the end of the last turn or when asked (history.ts, usageOf);
// the runner's shape (runners/src/lib/usage.ts), passed on as it is. null: the runner had none to say.
export const usages = new Map<string, unknown>();
export const active = new Map<string, Run>(); // agent → run executing now
const chains = new Map<string, AgentRef[]>(); // agent → its run in progress's chain: it, then who waits on it (tell's wait), and so on

/**
 * Tell an agent something the app owes it (the outcome of a command that waited: an answer, a reply): a message to it.
 * unattended: the command was part of a run nobody attends, so this is too.
 */
export function notify(ctx: Ctx, ref: AgentRef, text: string, unattended = false) {
  void startRun(ctx, { ...ref, message: text, caller: { kind: "pagent" }, ...(unattended ? { unattended } : {}) }).catch((e) => console.warn(`could not tell ${keyOf(ref)}: ${(e as Error).message}\n${text}`));
}

/** The message as views show it: the words as given, and who they are from (none for a person's own). */
export const userMessage = (text: string, caller?: Caller): UIMessage => ({
  id: randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
  metadata: caller && caller.kind !== "user" ? { caller } : undefined,
});

export type Push = (c: UIMessageChunk | null) => void;

export function newRun(ref: AgentRef, user: UIMessage, caller: Caller, unattended = caller.kind === "trigger", triggers = lineageOf(caller)): { run: Run; push: Push } {
  const run: Run = { id: randomUUID(), ref, caller, unattended, triggers, user, chunks: [], subscribers: new Set(), done: false, result: Promise.resolve("") };
  const push = (c: UIMessageChunk | null) => {
    if (c) run.chunks.push(c), (run.lastAt = Date.now());
    for (const s of run.subscribers) s(c);
  };
  return { run, push };
}

// ---------------------------------------------------------------- where a run comes from, for turn triggers

// A trigger's action running now → the triggers what fired it came from (a turn trigger fired by a turn some trigger
// led to): a tell in that action carries them on, with the trigger itself.
const firing = new Map<string, string[]>();

/** For triggers.ts: the trigger `key` runs now, fired by something that came from `from` (none: a tick, a change). */
export function triggerFiring(key: string, from: string[] | null) {
  if (from) firing.set(key, from);
  else firing.delete(key);
}

/**
 * The triggers a message comes from: its caller's, when that is a trigger (and what fired that trigger came from), or
 * an agent's run in progress (a delegation goes on as the run it came from). A person, a page, the engine: none.
 */
export function lineageOf(caller: Caller): string[] {
  if (caller.kind === "trigger") {
    const key = `${caller.node}#${caller.name}`;
    return [...new Set([key, ...(firing.get(key) ?? [])])];
  }
  if (caller.kind === "agent") return activeRun(caller)?.triggers ?? [];
  return [];
}

/**
 * A turn starting or ending, or the agent saying something outside any turn (saidOutside): for turn triggers
 * (triggers.ts). reply: at the end, the final text of its reply; a message's words.
 */
export type TurnListener = (phase: "start" | "end" | "message", run: Run, reply?: string) => void;
const turnListeners = new Set<TurnListener>();
export function onTurn(cb: TurnListener): () => void {
  turnListeners.add(cb);
  return () => void turnListeners.delete(cb);
}
const turned: TurnListener = (phase, run, reply) => {
  for (const l of turnListeners) {
    try {
      l(phase, run, reply);
    } catch (e) {
      console.warn(`a turn listener failed: ${(e as Error).message}`);
    }
  }
};

/**
 * What an agent said outside any turn, as its runner reports it (a `said` event, from its session or a quick op: a
 * Grok Bot's scheduled report, a reply after its turn ended, its answer to someone who wrote to it elsewhere): a
 * "message" for turn triggers, shaped as a turn's end. to: the message it answers, as the runner's history has it (its
 * id there, its words with their "(from …)" line, the app's run that sent it); none: it spoke on its own, and the
 * message is from itself. No run is made: nothing waits for it, and the views hear of it from the transcript (as of a
 * turn typed in a terminal).
 */
export function saidOutside(ctx: Ctx, ref: AgentRef, said: { id: string; text: string; to?: { id: string; text: string; run?: string } }) {
  const { to } = said;
  const line = to ? parseLine(to.text) : null;
  const caller: Caller = !to ? { kind: "agent", ...ref } : (line?.caller ?? { kind: "user" });
  const user: UIMessage = { id: to ? (appIdMap(ctx, ref)[to.id] ?? to.id) : said.id, role: "user", parts: [{ type: "text", text: line?.message ?? to?.text ?? "" }] };
  // What it came from: the trigger that told it what it answers (a turn trigger is not fired by its own action's doing).
  const { run } = newRun(ref, user, caller, false, caller.kind === "trigger" ? [`${caller.node}#${caller.name}`] : []);
  run.id = to?.run ?? "";
  turned("message", run, said.text);
}

function runStarted(run: Run, chain: AgentRef[] | undefined, clientId?: string) {
  const { ref } = run;
  run.startedAt ??= Date.now();
  run.lastAt = Date.now();
  active.set(keyOf(ref), run);
  chains.set(keyOf(ref), chain?.length ? chain : [ref]);
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-start", runId: run.id, user: run.user, clientId: clientId ?? null } });
  turned("start", run);
}

/**
 * End a run; a delegation then reports back: the result arrives at the delegating agent as a new message, or (a message
 * from outside) is POSTed to the sender's address.
 */
function runEnded(ctx: Ctx, run: Run, push: Push, text: string, how: RunFor) {
  const { replyTo, replyPost } = how;
  const { ref } = run;
  run.done = true;
  noteRun(ctx, run); // before anyone reads its history again: the turn keeps its id there
  // The agent has a session now: one declared without a cli keeps the harness it is on (settings.ts, pinHarness).
  if (hadSession(run)) {
    if (run.harness) pinHarness(nodeFolder(ctx, ref), ref.agent, run.harness);
    else void declOf(ctx, ref).then((d) => d?.defaultHarness && pinHarness(nodeFolder(ctx, ref), ref.agent, d.runner), () => {});
  }
  push(null);
  forget(ref);
  watchAfter(ctx, ref, run);
  if (active.get(keyOf(ref)) === run) {
    active.delete(keyOf(ref)); // a message steered into the same turn may have taken over
    chains.delete(keyOf(ref));
  }
  broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "run-end", runId: run.id } });
  turned("end", run, text);
  // Stopped before it began: not tried again. Not taken: why, as its runner said (the run's last error).
  const why = (run.chunks as { type: string; errorText?: string }[]).findLast((c) => c.type === "error")?.errorText;
  if (!run.taken) run.stopped ? run.letter?.taken() : run.letter?.untaken(why);
  // An unattended run's result carries on what the trigger started: nobody is there for that run either; and it comes
  // from the triggers the run came from.
  const alone = run.unattended ? { unattended: true } : {};
  if (replyTo) void ask(ctx, { ...replyTo, message: `${resultOf(ref, run.id)}\n${text || "(no reply)"}`, caller: { kind: "agent", ...ref }, ...alone, triggers: run.triggers }).catch((e) => console.warn(`could not report back to ${keyOf(replyTo)}: ${(e as Error).message}`));
  if (replyPost) void postReply(ctx, replyPost, text, run.id, ref).catch((e) => console.warn(`${keyOf(ref)}: could not send the reply to ${replyPost.url}: ${(e as Error).message}`));
}

/**
 * Did the run leave the agent with a session? Its runner said which session it is on (data-session) or where its
 * message is in the transcript (data-user), or its turn ended (finish) without an error. A turn that failed before the
 * harness ran, or was stopped before it began, did not.
 */
const hadSession = (run: Run) =>
  !!run.historyId || run.chunks.some((c: any) => c.type === "data-session" && c.data?.sessionId) || (run.chunks.some((c) => c.type === "finish") && !run.chunks.some((c) => c.type === "error"));

/** The head of a delegation's result: which agent, and which message of the delegating agent's it answers. */
export const resultOf = (ref: AgentRef, id: string) => `Result of your delegation to ${keyOf(ref)} (message ${id}):`;

/** Who a run is for, besides its agent: the chain it is part of, the chat that started it, whom it reports back to. */
export type RunFor = { chain?: AgentRef[]; clientId?: string; replyTo?: AgentRef; replyPost?: ReplyPost };

/**
 * The result of a run for someone outside, to the address it gave: { text, from: our message route for the agent,
 * inReplyTo: the message it answers (the sender's id for it, or ours) }. A reply is never answered automatically (tell.ts), so this ends there.
 */
export async function postReply(ctx: Ctx, to: ReplyPost, text: string, inReplyTo: string, by: AgentRef) {
  const r = await postOut(to.url, Number(new URL(ctx.baseUrl).port), to.path, { text: text || "(no reply)", inReplyTo: to.inReplyTo ?? inReplyTo }, 30_000);
  if (r.status >= 300) throw new Error(`${r.status} ${r.body.slice(0, 200)}`);
  answered(ctx, to, text, by); // to a remote agent of ours: in its conversation
}

/**
 * Execute a run: started (its viewers hear of it), its turn delivered by the driver, ended (its result reported back).
 * `queued`: after the agent's run before it, else at once (it still counts as busy until it ends). A queued run with
 * runs before it waits in the open (status's `queued`) until its turn comes, and may be withdrawn meanwhile (unqueue).
 */
export function schedule(ctx: Ctx, run: Run, push: Push, queued: boolean, how: RunFor, turn: () => Promise<string>): Run {
  const key = keyOf(run.ref);
  const ahead = open.get(key) ?? 0;
  open.set(key, ahead + 1);
  const execute = async () => {
    try {
      if (run.withdrawn) return "";
      unwait(run);
      runStarted(run, how.chain, how.clientId);
      let text = "";
      try {
        text = await turn();
      } catch (e) {
        push({ type: "error", errorText: (e as Error).message });
      } finally {
        runEnded(ctx, run, push, text, how);
      }
      return text;
    } finally {
      const left = (open.get(key) ?? 1) - 1;
      if (left) open.set(key, left);
      else open.delete(key);
    }
  };
  if (queued && ahead) {
    waiting.set(key, [...(waiting.get(key) ?? []), run]);
    queueChanged(run.ref);
  }
  if (queued) {
    const prev = queues.get(key) ?? Promise.resolve();
    run.result = prev.then(execute, execute);
    queues.set(key, run.result);
  } else {
    run.result = execute();
    queues.set(key, Promise.allSettled([queues.get(key), run.result]));
  }
  return run;
}

/** The messages waiting for the agent's turn, oldest first, as status views show them: each its run's id, message and caller. */
export const queuedOf = (ref: AgentRef) => (waiting.get(keyOf(ref)) ?? []).map((r) => ({ id: r.id, user: r.user, caller: r.caller }));

const queueChanged = (ref: AgentRef) => broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "queued", queued: queuedOf(ref) } });

/** No longer waiting: its turn came, or it was withdrawn. */
function unwait(run: Run) {
  const key = keyOf(run.ref);
  const list = waiting.get(key);
  if (!list?.includes(run)) return;
  const rest = list.filter((r) => r !== run);
  if (rest.length) waiting.set(key, rest);
  else waiting.delete(key);
  queueChanged(run.ref);
}

/**
 * Withdraw a message still waiting for the agent's turn (a person's "don't send it"): it never reaches the agent, its
 * letter goes, and whoever follows its run sees it end. false: no such message waits (its turn came, or it is gone).
 */
export function unqueue(ref: AgentRef, id: string): boolean {
  const run = waiting.get(keyOf(ref))?.find((r) => r.id === id);
  if (!run) return false;
  run.withdrawn = true;
  run.done = true;
  run.letter?.taken(); // nothing left to deliver
  unwait(run);
  for (const s of run.subscribers) s(null);
  run.subscribers.clear();
  return true;
}

/** The runner's chunks, as a run sees them: the final text and session info are noted, the rest is streamed. */
export function chunkHandler(run: Run, push: (c: UIMessageChunk) => void, setText: (t: string) => void) {
  const { ref } = run;
  // label: the one line it has always been ("Bash git status"); doing: the same in parts (status.ts, Activity).
  const activity = (label: string, doing: Activity) => broadcast({ type: "agent", node: ref.node, agent: ref.agent, event: { type: "activity", runId: run.id, label, doing } });
  const subs = new Map<string, SubagentLine>(); // the run's sub-agents, as last described
  return (c: any) => {
    if (c.type === "data-result") return void setText(String(c.data?.text ?? ""));
    if (c.type === "data-user") return void (c.data?.id && (run.historyId = String(c.data.id))); // its message's id in the transcript
    if (c.type === "data-session") sessions.set(keyOf(ref), c.data ?? {});
    if (c.type === "data-usage" && c.data) usages.set(keyOf(ref), c.data);
    if (c.type === "tool-input-start" || c.type === "tool-input-available") activity(toolActivity(c), toolDoing(c));
    if (c.type === "data-subagent" && c.data) {
      const was = subs.get(c.id);
      subs.set(c.id, c.data);
      if (!was && c.data.status === "running") activity(subagentActivity(c.data), subagentDoing(c.data));
    }
    // A sub-agent's new call: what it does now.
    if (c.type === "data-subagent-step" && c.data?.part?.type === "dynamic-tool" && c.data.part.state === "input-available") {
      const s = subs.get(c.data.of);
      if (s?.status === "running") activity(subagentActivity(s, c.data.part), subagentDoing(s, c.data.part));
    }
    push(c);
  };
}

export type StartOptions = {
  /** A letter a previous server left in the inbox, delivered now: its id (the run's), when it was written, failed tries. */
  letter?: { id: string; at: number; tries?: number };
  /** Who waits for the result right now (`pagent tell --wait`, tell()'s wait): if a later server delivers the message, it reports back. */
  replyIfLate?: Pick<AskInput, "replyTo" | "replyPost">;
};

const GIVE_UP = 3;

/**
 * The messages a previous server did not get to their agents, delivered now in the order they were written (after the
 * turns taken up from the daemon, which go first). One whose turn the daemon ran already had arrived.
 */
export async function redeliver(ctx: Ctx) {
  for (const l of letters(ctx.root)) {
    if (l.kind !== "message") continue;
    const to = `${l.input.node}#${l.input.agent}`;
    if (known.has(l.id)) {
      drop(ctx.root, l.id);
      continue;
    }
    if ((l.tries ?? 0) >= GIVE_UP) {
      console.warn(`${to}: giving up on a message that did not reach it ${l.tries} times: ${l.input.message.slice(0, 300)}`);
      drop(ctx.root, l.id);
      continue;
    }
    console.log(`${to}: delivering a message the previous server did not`);
    await startRun(ctx, l.input, { letter: l }).catch((e) => console.warn(`${to}: ${(e as Error).message}; dropped: ${l.input.message.slice(0, 300)}`));
  }
}

/** Start a run (after the agent's current one, unless its driver sends at once) and return it immediately. */
export async function startRun(ctx: Ctx, input: AskInput, opts: StartOptions = {}): Promise<Run> {
  // An instance of a dynamic page is made by opening its page or `tell --new`, never by a message on its way (tree.ts).
  if (notMade(ctx.root, input.node)) throw new Error(`${input.node} is not made (an instance of a dynamic page that is not there, or no longer)`);
  // Written down before anything else (inbox.ts), under the run's id: kept until the harness has the message.
  const letter: MessageLetter = { kind: "message", id: opts.letter?.id ?? randomUUID(), at: opts.letter?.at ?? Date.now(), input: { ...input }, ...(opts.letter?.tries ? { tries: opts.letter.tries } : {}) };
  const late = opts.replyIfLate;
  if (late?.replyTo && !letter.input.replyTo) letter.input.replyTo = late.replyTo;
  if (late?.replyPost && !letter.input.replyPost) letter.input.replyPost = late.replyPost;
  keep(ctx.root, letter);
  const ref: AgentRef = { node: input.node, agent: input.agent };
  let found: [AgentDecl, SessionDriver];
  try {
    const decl = await agentDecl(ctx, ref);
    if (decl.remote === undefined) runnerScript(decl.runner); // a remote agent has no runner here
    found = [decl, await driverOf(decl)];
  } catch (e) {
    drop(ctx.root, letter.id); // it can never be delivered
    throw e;
  }
  const [decl, driver] = found;
  // Where it comes from, in the line itself (caller.ts); a person's words in their conversation arrive as they are.
  const message = callerLine(input.caller, input.message);
  const { run, push } = newRun(ref, input.user ?? userMessage(input.message, input.caller), input.caller, input.unattended, input.triggers ?? lineageOf(input.caller));
  run.id = letter.id;
  if (decl.defaultHarness) run.harness = decl.runner;
  run.letter = {
    taken: () => drop(ctx.root, letter.id),
    // Not delivered while this server ran (an error on the way): kept for the next server to try, unless a person
    // wrote it in a conversation, who saw it fail there.
    untaken: (why) => {
      if (input.caller.kind === "user") return drop(ctx.root, letter.id);
      keep(ctx.root, { ...letter, tries: (letter.tries ?? 0) + 1 });
      console.warn(`${keyOf(ref)}: a message did not reach the agent${why ? ` (${why.split("\n")[0].slice(0, 300)})` : ""}; it is tried again when the server next starts`);
    },
  };
  // An interjection goes into the turn in progress when the agent's harness takes it there now; else it waits its turn.
  // A message a person queued waits whatever the driver does with one during a turn (a thread's harness steers it in).
  const queued = !!input.queue || (driver.queued && !(input.interject && driver.interjects?.(ref)));
  return schedule(ctx, run, push, queued, input, () => driver.turn({ ctx, run, push, input: queued ? { ...input, interject: false } : input, decl, message }));
}

export async function ask(ctx: Ctx, input: AskInput): Promise<string> {
  return (await startRun(ctx, input)).result;
}

/** One process per session: another one that has this agent's session open right now (its driver knows how to tell). */
export async function conflictOf(ctx: Ctx, ref: AgentRef): Promise<Conflict | null> {
  return (await driverFor(ctx, ref)).conflict(ctx, ref);
}

/**
 * Stop the agent's turn in progress, as Esc in its TUI does (its driver knows how): what was done, or null when it was
 * in none. Messages waiting for it still come after.
 */
export async function stopTurn(ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const said = await (await driverFor(ctx, ref)).stop(ctx, ref);
  if (said) console.log(`${keyOf(ref)}: ${said}`);
  return said;
}

/** Do this agent's runs wait for each other (and a TUI opened by hand for them)? */
export async function turnsQueued(ctx: Ctx, ref: AgentRef): Promise<boolean> {
  return (await driverFor(ctx, ref)).queued;
}

/** Resolves once the agent has no run queued or running (a run started meanwhile is waited for too). */
export async function whenIdle(ref: AgentRef): Promise<void> {
  for (;;) {
    const tail = queues.get(keyOf(ref));
    await tail?.catch(() => {});
    if (queues.get(keyOf(ref)) === tail) return;
  }
}

/** The agent's run in progress is unattended: nobody is there to approve or answer. */
export const unattended = (ref: AgentRef) => !!activeRun(ref)?.unattended;

/**
 * Is a message from this caller unattended? From a trigger, and from an agent in an unattended run: a delegation goes on
 * as the run it came from (trigger → a → b, through any number of agents), so a person on the way (their chat, a page's
 * button) makes the rest attended. The agent's run says which it is (via names the code on the way, not the agents).
 */
export const unattendedFrom = (c: Caller): boolean => c.kind === "trigger" || (c.kind === "agent" && unattended(c));
export const NOBODY =
  "Nobody can answer: this run comes from a trigger (or an agent's run that one started) and is unattended. Do what you can with your file tools, " +
  "and leave a short note in the app's data for the user about anything that needs them.";

/** Ask the user, unless the run is unattended. Then the answer is that nobody is there. */
export async function askOrDecline(ref: AgentRef, ask: () => Promise<string>): Promise<{ declined: boolean; answer: string }> {
  return unattended(ref) ? { declined: true, answer: NOBODY } : { declined: false, answer: await ask() };
}

export function activeRun(ref: AgentRef): Run | undefined {
  return active.get(keyOf(ref));
}

/** Replay a run's chunks so far, then follow it live. `cb(null)` marks the end. */
export function follow(run: Run, cb: (c: UIMessageChunk | null) => void): () => void {
  for (const c of run.chunks) cb(c);
  if (run.done) {
    cb(null);
    return () => {};
  }
  run.subscribers.add(cb);
  return () => run.subscribers.delete(cb);
}

/** The agents waiting on this one's run in progress, it first (a run nobody waits on: just it). */
export const chainOf = (ref: AgentRef): AgentRef[] => chains.get(keyOf(ref)) ?? [ref];

/** Is `target` already waiting somewhere up the chain of `from`'s run? Then a waiting call to it would deadlock. */
export function inChain(from: AgentRef, target: AgentRef): boolean {
  return (chains.get(keyOf(from)) ?? []).some((r) => r.node === target.node && r.agent === target.agent);
}

/** Take back what the daemon kept running for this app while no server was there (each driver what is its own). */
export async function recoverAgents(ctx: Ctx) {
  for (const d of drivers()) await d.recover(ctx);
}

/** Give back what nobody uses (every minute). */
export function closeQuietAgents() {
  for (const d of drivers()) d.closeQuiet();
  noteStuck();
}

/** Bring what runs an updated harness's older version up to date, once nobody needs it (every minute). */
export async function refreshAgents(ctx: Ctx) {
  for (const d of drivers()) await d.refresh?.(ctx).catch((e: Error) => console.warn(`refreshing agents: ${e.message}`));
  await refreshTuis(ctx).catch((e: Error) => console.warn(`refreshing terminals: ${e.message}`));
}
