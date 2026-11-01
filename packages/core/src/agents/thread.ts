// The thread driver (driver.ts), for a runner whose turns are "thread": the agent is a long-lived client of a thread
// its harness shares, run by the runner's "session" op in the daemon (so it stays subscribed across server restarts,
// which keeps the thread loaded with pagent's additions). The thread lives on the runner's shared service, which the
// daemon keeps running (the runner's "service" op); every message goes to it, from wherever: the app's turns, a turn
// typed into the TUI (one more client of the thread), a message steered into a running turn. Each turn's events come
// back here as one stream, and each message in it is a run. What the harness says outside any turn (a Grok Bot's
// schedules) the session reports as `said`, for turn triggers; an agent declared `follow` keeps its session while the
// app runs, so its runner goes on looking.
import { daemonPaths } from "../daemon-protocol.ts";
import { attachProc, listProcs, procOp, spawnProc, type ProcEvent } from "../daemon-client.ts";
import { onEvent } from "../events.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { harnessEnv } from "../shell-env.ts";
import { isBusy, openTerminal, stopTerminal, terminalOf, whenClosed } from "../terminal.ts";
import { programChanged, programOf } from "../program.ts";
import { listNodes } from "../tree.ts";
import type { SessionDriver, Turn } from "./driver.ts";
import { pinHarness } from "../settings.ts";
import { agentDecl, agentInput, capabilitiesOf, invoke, lineReader, nodeFolder, runnerBase, runnerScript, turnsOf } from "./runner.ts";
import { chunkHandler, known, newRun, saidOutside, schedule, taken, userMessage, type Push } from "./runs.ts";
import { interactiveCommand } from "./tui.ts";
import type { Ctx, Run } from "./types.ts";

export const thread: SessionDriver = {
  queued: false, // the thread takes any number of messages; the harness steers one into the turn in progress
  turn,
  conflict: async () => null, // the thread takes any number of clients; another process writing it stops the session from starting, which says so
  opInput,
  tui,
  recover: recoverSessions,
  closeQuiet: closeQuietSessions,
  refresh: refreshSessions,
  stop,
};

type Bound = { run: Run; push: Push; forward: (c: any) => void; resolve: (text: string) => void };
type Live = {
  id: string; // the session's process in the daemon
  ref: AgentRef;
  threadId?: string;
  ready: Promise<void>;
  waiting: Map<string, Bound>; // runs whose message has not shown up in a turn yet
  bound: Bound[]; // the runs the current turn answers (more than one when a message was steered into it)
  usedAt: number;
  stopping?: boolean;
  /** Its harness takes a message into the turn in progress (its describe's interject); otherwise its session queues it. */
  steers?: boolean;
  /** Where another client attaches to its session (its TUI), when its runner says (ready's endpoint). */
  endpoint?: string;
  /** Declared without a cli: the harness it runs, which it keeps once its thread is there (settings.ts, pinHarness). */
  harness?: string;
  /** Declared `follow` (as declared when it started): its runner looks for what the harness does on its own, so it stays while the app runs. */
  follows?: string;
  /** Its runner, and the daemon process of the runner's service it is a client of (refreshSessions). */
  script?: string;
  service?: string;
};
const lives = new Map<string, Live>();
// Runs whose session is still being made (ensureSession): busy already, but not in `lives` yet, so a stop must find them.
const starting = new Map<string, Set<Run>>();
const SESSION_IDLE = 10 * 60_000; // no TUI, no turn, for this long: the session ends (the thread is resumed next time)

/**
 * The runner's shared background process, running in the daemon. Its environment is the one every thread on it
 * shares, so it carries nothing of any agent (what is per agent goes in per thread), nor what the runner says to leave
 * out (envDrop: name prefixes); it runs where the runner says (cwd), else in pagent's home (it belongs to no agent).
 * The program it runs updated since the runner said what it is (program.ts): asked again, and a runner that gives each
 * version a service of its own (Codex: a socket per version) has the new one started next to the old, which keeps its
 * sessions until they move (refreshSessions). Its daemon process id, or undefined when the runner has none.
 */
type Service = { svc: any; program: string };
const services = new Map<string, Promise<Service>>();
async function serviceOf(script: string, cwd: string): Promise<any> {
  const PATH = (await harnessEnv()).PATH;
  const have = services.get(script);
  if (have && !programChanged((await have.catch(() => null))?.program, PATH)) return (await have).svc;
  const next = (async () => {
    let svc: any = null;
    await invoke(script, { op: "service" }, cwd, (e) => e.type === "service" && (svc = e));
    return { svc, program: svc ? programOf(svc.command, PATH) : "" };
  })();
  services.set(script, next);
  next.catch(() => services.get(script) === next && services.delete(script));
  return (await next).svc;
}
async function ensureService(script: string, cwd: string): Promise<string | undefined> {
  const svc = await serviceOf(script, cwd);
  if (!svc) return;
  const drop: string[] = Array.isArray(svc.envDrop) ? svc.envDrop.map(String) : [];
  const env = Object.fromEntries(Object.entries(await harnessEnv()).filter(([k]) => !drop.some((p) => k.startsWith(p))));
  const where = typeof svc.cwd === "string" && svc.cwd ? svc.cwd : daemonPaths().home;
  await spawnProc({ id: svc.id, kind: "pipe", command: svc.command, args: svc.args, cwd: where, env, open: true, service: true, meta: { type: "service", script } }).catch(
    (e) => /already running/.test((e as Error).message) || Promise.reject(e),
  );
  return svc.id;
}

/** The agent's session, started (with its thread opened) if it is not running. */
function ensureSession(ctx: Ctx, ref: AgentRef): Promise<Live> {
  const key = keyOf(ref);
  const have = lives.get(key);
  if (have && !have.stopping) return have.ready.then(() => have);
  let ok = () => {};
  let fail = (_: Error) => {};
  const live: Live = { id: `session:${ctx.root}:${key}:${Date.now()}`, ref, ready: new Promise((y, n) => ((ok = y), (fail = n))), waiting: new Map(), bound: [], usedAt: Date.now() };
  lives.set(key, live);
  void (async () => {
    const decl = await agentDecl(ctx, ref);
    const script = runnerScript(decl.runner);
    const base = runnerBase(ctx, ref, decl);
    live.steers = (await capabilitiesOf(decl)).interject;
    if (decl.defaultHarness) live.harness = decl.runner;
    if (decl.follow) live.follows = String(decl.follow);
    live.script = script;
    live.service = await ensureService(script, base.cwd);
    const input = { op: "session", ...base, ...(await agentInput(ctx, ref, decl)) };
    const service = live.service ? { script, service: live.service } : {};
    await spawnProc(
      { id: live.id, kind: "pipe", command: process.execPath, args: [script], cwd: base.cwd, env: await harnessEnv(), stdin: JSON.stringify(input) + "\n", open: true, meta: { app: ctx.root, type: "session", ...ref, steers: live.steers, follows: live.follows, ...service } },
      sessionEvents(ctx, live, ok, fail),
    );
  })().catch((e) => {
    if (lives.get(key) === live) lives.delete(key);
    fail(e);
  });
  return live.ready.then(() => live);
}

/** A session's output: its thread, then turns. Each message in a turn binds a run: the app's own, or a new one. */
function sessionEvents(ctx: Ctx, live: Live, ok: () => void, fail: (e: Error) => void) {
  let failure = "";
  const read = lineReader((e) => {
    live.usedAt = Date.now();
    switch (e.type) {
      case "ready":
        live.threadId = e.threadId;
        if (typeof e.endpoint === "string") live.endpoint = e.endpoint;
        // The agent has a session on this harness now: one declared without a cli keeps it.
        if (e.threadId && live.harness) pinHarness(nodeFolder(ctx, live.ref), live.ref.agent, live.harness);
        return ok();
      case "failed":
        return void (failure = e.errorText);
      case "turn":
        live.bound = [];
        return;
      case "user": {
        if (live.bound.some((b) => b.run.id === e.clientId)) return; // told again (a restarted server asked)
        const b = live.waiting.get(e.clientId) ?? adopt(ctx, live, e);
        live.waiting.delete(e.clientId);
        if (e.id) b.run.historyId = String(e.id); // the thread's own id for the message (ids.ts)
        taken(b.run);
        b.push({ type: "start", messageMetadata: { turnId: e.turnId } });
        live.bound.push(b);
        return;
      }
      case "turn-end":
        for (const b of live.bound.splice(0)) {
          b.push({ type: "finish", messageMetadata: { turnId: e.turnId, status: e.status, durationMs: e.durationMs } });
          b.resolve(String(e.text ?? ""));
        }
        return;
      case "ask-failed": {
        const b = live.waiting.get(e.run);
        live.waiting.delete(e.run);
        b?.push({ type: "start" });
        b?.push({ type: "error", errorText: e.errorText });
        return b?.resolve("");
      }
      case "said": // the agent said something outside any turn (runs.ts)
        return saidOutside(ctx, live.ref, e);
      default: // a chunk of the current turn
        for (const b of live.bound) b.forward(e);
    }
  });
  return (e: ProcEvent) => {
    if (e.ev === "data") read(e.data);
    else if (e.ev === "stderr") process.stderr.write(e.data);
    else if (e.ev === "exit") {
      if (!e.lost) procOp("reap", live.id);
      sessionGone(ctx, live, failure || (e.lost ? "the pagent daemon went away" : `the agent's session ended (${e.code})`));
      fail(new Error(failure || "the agent's session did not start"));
    }
  };
}

/**
 * A message the app did not send (typed into the TUI), or one sent before this server started: a run of its own. One
 * typed into the TUI is known by the thread's id for it, as its history has it.
 */
function adopt(ctx: Ctx, live: Live, e: any): Bound {
  const m = e.meta ?? {};
  const { run, push } = newRun(live.ref, m.user ?? { ...userMessage(e.text), ...(e.id ? { id: String(e.id) } : {}) }, m.caller ?? { kind: "user" }, m.unattended);
  if (m.user && e.clientId) run.id = e.clientId;
  known.add(run.id);
  let resolve = (_: string) => {};
  const done = new Promise<string>((r) => (resolve = r));
  schedule(ctx, run, push, false, { chain: m.chain, replyTo: m.replyTo, replyPost: m.replyPost }, () => done);
  return { run, push, forward: chunkHandler(run, push, () => {}), resolve };
}

/** A run on the agent's thread: its message goes to the session at once, and it ends with the turn that answers it. */
async function turn({ ctx, run, push, input, message }: Turn): Promise<string> {
  const key = keyOf(run.ref);
  const pending = starting.get(key) ?? starting.set(key, new Set()).get(key)!;
  pending.add(run);
  try {
    const live = await ensureSession(ctx, run.ref).finally(() => {
      pending.delete(run);
      if (!pending.size && starting.get(key) === pending) starting.delete(key);
    });
    if (run.stopped) return ""; // stopped while its session was starting: its message is never sent
    return await new Promise<string>((resolve) => {
      live.waiting.set(run.id, { run, push, forward: chunkHandler(run, push, () => {}), resolve });
      const meta = { caller: input.caller, unattended: run.unattended, user: run.user, chain: input.chain, replyTo: input.replyTo, replyPost: input.replyPost };
      procOp("write", live.id, { data: JSON.stringify({ op: "ask", run: run.id, message, meta }) + "\n" });
    });
  } catch (e) {
    push({ type: "start" });
    push({ type: "error", errorText: (e as Error).message });
    return "";
  }
}

/** Stop the turn the agent's session is in (the runner's "interrupt": Codex's turn/interrupt); its runs end with it. */
async function stop(_ctx: Ctx, ref: AgentRef): Promise<string | null> {
  const live = lives.get(keyOf(ref));
  const pending = [...(starting.get(keyOf(ref)) ?? [])];
  const inTurn = live ? [...live.bound, ...live.waiting.values()].map((b) => b.run) : [];
  if (!inTurn.length && !pending.length) return null;
  for (const r of [...inTurn, ...pending]) r.stopped = true;
  if (inTurn.length) procOp("write", live!.id, { data: `${JSON.stringify({ op: "interrupt" })}\n` });
  return "interrupted the turn in progress";
}

/** Is the agent a client of its thread now, and does a message to it go into its turn in progress (its harness steers)? */
export const onThread = (ref: AgentRef) => !!lives.get(keyOf(ref))?.steers;

/**
 * End the agent's session now (its node moves, `pagent mv`: the process has the old folder and the old address). The
 * thread stays; the next message opens it again from the new place.
 */
export async function endSession(ref: AgentRef): Promise<void> {
  const live = lives.get(keyOf(ref));
  if (!live) return;
  live.stopping = true;
  procOp("write", live.id, { data: `${JSON.stringify({ op: "stop" })}\n` });
  for (let i = 0; i < 100 && lives.get(keyOf(ref)) === live; i++) await new Promise((r) => setTimeout(r, 100));
}

/** The runner's quick ops read the thread the agent's session has open (and its service must be up to answer). */
async function opInput(_ctx: Ctx, ref: AgentRef, script: string, cwd: string): Promise<Record<string, unknown>> {
  await ensureService(script, cwd);
  const threadId = lives.get(keyOf(ref))?.threadId;
  return threadId ? { thread: threadId } : {};
}

/** A TUI attaches to the thread the agent's session opened, with pagent's additions, and must not outlive the session. */
async function tui(ctx: Ctx, ref: AgentRef) {
  const live = await ensureSession(ctx, ref);
  return { input: { thread: live.threadId, ...(live.endpoint ? { endpoint: live.endpoint } : {}) }, session: live.id };
}

/**
 * The session ended: its runs fail. A TUI attached to that thread would reconnect to a restarted service by itself
 * and resume the thread without pagent's additions, so it is closed, and started again once the session is back
 * (session first: it reopens the thread with the additions).
 */
function sessionGone(ctx: Ctx, live: Live, why: string) {
  const key = keyOf(live.ref);
  if (lives.get(key) === live) lives.delete(key);
  for (const b of [...live.waiting.values(), ...live.bound]) {
    b.push({ type: "error", errorText: why });
    b.resolve("");
  }
  live.waiting.clear();
  live.bound = [];
  const term = terminalOf(live.ref);
  if (!term || term.session !== live.id) return;
  stopTerminal(term, true);
  if (live.stopping) return;
  console.warn(`${key}: ${why}; restarting its session, then its terminal`);
  void whenClosed(term)
    .then(async () => openTerminal(live.ref, await interactiveCommand(ctx, live.ref), { cols: 120, rows: 40 }))
    .catch((e) => console.warn(`${key}: the terminal did not come back (${(e as Error).message}); the agent still works from the app`));
}

/** Take back the sessions the daemon kept running for this app, and close TUIs whose session is gone. */
async function recoverSessions(ctx: Ctx) {
  const procs = await listProcs(ctx.root);
  const running = new Set(procs.filter((p) => p.meta.type === "session" && !p.exit).map((p) => p.id));
  for (const p of procs) {
    if (p.kind === "pty" && p.meta.session && !p.exit && !running.has(p.meta.session)) {
      console.log(`closing the terminal of ${p.meta.node}#${p.meta.agent}: its session is gone`);
      procOp("kill", p.id);
    }
    if (!running.has(p.id)) continue;
    const ref = { node: p.meta.node, agent: p.meta.agent };
    let ok = () => {};
    const live: Live = { id: p.id, ref, ready: new Promise<void>((y) => (ok = y)), waiting: new Map(), bound: [], usedAt: Date.now(), steers: p.meta.steers !== false, ...(p.meta.follows ? { follows: String(p.meta.follows) } : {}), ...(p.meta.service ? { script: p.meta.script, service: p.meta.service } : {}) };
    lives.set(keyOf(ref), live);
    await attachProc(p.id, sessionEvents(ctx, live, ok, () => {}));
    procOp("write", p.id, { data: `${JSON.stringify({ op: "state" })}\n` }); // its thread, and the turn in progress
  }
  void startFollowing(ctx);
  let again: NodeJS.Timeout | undefined;
  onEvent((e) => {
    if (e.type !== "code") return;
    clearTimeout(again);
    again = setTimeout(() => void startFollowing(ctx), 1000);
  });
}

/**
 * The sessions of the agents declared `follow` (their harness acts on its own, and their runner looks for what it
 * said), started with the app and when a declaration says so. A session started with another `follow` (none, or
 * another span) starts again once it is not in a turn: its runner reads it as it starts.
 */
async function startFollowing(ctx: Ctx) {
  for (const node of listNodes(ctx.root)) {
    const d = await ctx.nodes.declarations(node).catch(() => null);
    for (const decl of d?.manifest.agents ?? []) {
      const ref = { node, agent: decl.name };
      const follow = decl.follow ? String(decl.follow) : undefined;
      const live = lives.get(keyOf(ref));
      if (live?.follows === follow) continue;
      if (live && (live.bound.length || live.waiting.size || !live.threadId)) continue; // in a turn (or starting): next time
      if (!live && (!follow || (await turnsOf(decl).catch(() => null)) !== "thread")) continue;
      const start = () => ensureSession(ctx, ref).catch((e) => console.warn(`${keyOf(ref)}: its session did not start (${(e as Error).message}); it is followed from its next turn`));
      if (live) void endSession(ref).then(() => void (follow && start()));
      else void start();
    }
  }
}

/**
 * The sessions on a service that is not their runner's current one any more (its harness was updated: serviceOf),
 * in no turn and with nobody in their TUI: ended and started again on the current one, with their TUI and their
 * following as they were. A service nobody's session uses (in any app) once its runner has another: stopped.
 */
async function refreshSessions(ctx: Ctx) {
  const current = new Map<string, string | undefined>();
  for (const live of [...lives.values()]) {
    if (!live.script || !live.service || live.stopping || !live.threadId) continue;
    if (!current.has(live.script)) current.set(live.script, await ensureService(live.script, nodeFolder(ctx, live.ref)).catch(() => undefined));
    const now = current.get(live.script);
    const term = terminalOf(live.ref);
    if (!now || now === live.service || live.bound.length || live.waiting.size) continue;
    if (term && (term.viewers.size || isBusy(term.status?.state) || term.dialog)) continue;
    const { ref } = live;
    console.log(`${keyOf(ref)}: its harness was updated; moving its session to the new one (${now})`);
    await endSession(ref);
    if (term) await whenClosed(term);
    try {
      if (live.follows || term) await ensureSession(ctx, ref);
      if (term && !terminalOf(ref)) await openTerminal(ref, await interactiveCommand(ctx, ref), { cols: 120, rows: 40 });
    } catch (e) {
      console.warn(`${keyOf(ref)}: its session did not come back on the new service (${(e as Error).message}); the next message starts it`);
    }
  }
  // Old services: those of a runner that has another now, which no session (of any app) uses.
  const procs = await listProcs();
  const used = new Set(procs.filter((p) => p.meta.type === "session" && !p.exit && p.meta.service).map((p) => String(p.meta.service)));
  for (const p of procs) {
    const script = p.meta.type === "service" && !p.exit ? String(p.meta.script ?? "") : "";
    if (!script || !current.has(script) || current.get(script) === p.id || used.has(p.id)) continue;
    console.log(`stopping ${p.id}: no session uses it, its harness was updated`);
    procOp("kill", p.id);
  }
}

/** End the sessions nobody uses: no TUI, no turn, quiet for a while. The thread stays; the next message resumes it. */
function closeQuietSessions() {
  for (const live of lives.values()) {
    if (live.follows || terminalOf(live.ref) || live.bound.length || live.waiting.size || Date.now() - live.usedAt < SESSION_IDLE) continue;
    live.stopping = true;
    procOp("write", live.id, { data: `${JSON.stringify({ op: "stop" })}\n` });
  }
}
