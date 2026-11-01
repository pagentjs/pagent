#!/usr/bin/env node
// runner:grokbot — a Grok Bot bot as an agent (SPEC 13.20; the contract: lib/contract.ts). Grok Bot is xAI's hosted,
// always-on agent on its own cloud computer (its X search is the reason to want one); it has no API, so the runner
// talks to it through gbot (npm grok-bot-cli, lib/gbot.ts), which reuses the Grok Bot desktop app's session. Declared
// `{ cli: "grokbot", bot: "Researcher" }` (a bot's name or id; createBot: true makes it when there is none).
//
// Turns go to a thread (the contract's "thread"): the agent's session is a long-lived process in the daemon that sends
// the app's messages to the bot (`gbot send`, the run's id as gbot's correlation id) and follows the bot's thread
// (`gbot thread`, read again every second or so in a turn, backing off to every few; between turns, every 15 s backing
// off to a minute while something may come: for 10 minutes after a turn or after the bot last said something; after
// that, every `follow` when the agent declares it, else not until the next turn). Each read may wake the bot's cloud
// computer (lib/gbot.ts), so nothing reads it for nothing. One turn at a time: a message sent during a turn waits
// (interject: false).
// A turn ends when the bot has said something and then nothing for a quiet stretch (20 s; GROKBOT_QUIET_MS, the
// declaration's quietSeconds), as nothing in the thread says that a request is done (as far as gbot shows); it gives up
// waiting after waitMinutes (30). Stop ends pagent's wait only: gbot cannot stop Grok Bot, which finishes what it does;
// what it says later shows in the history.
//
// What the thread shows (lib/grokbot-thread.ts): the bot's messages, whole (a reply arrives a message at a time; one the
// thread marks isStreaming would stream), the schedules it makes (as steps), approval cards; not its steps (its X search,
// a command it ran: the thread has none of them). A card becomes a permission request in the app (pagent's shape); the answer goes back with `gbot approvals
// respond`: accept once, or decline (never a lasting permission). A card decided in Grok Bot's own app goes away here.
//
// What the runner keeps (<stateDir>/grokbot/<bot>.jsonl: each entry as it saw it, what it sent, how turns ended, what
// was decided, what the app was told) is the history, the last words and the trajectory, read without gbot. What the
// bot says outside a turn (a schedule's report, a reply after its turn ended, its answer to someone who wrote to it in
// Grok Bot's own app or with gbot) reaches the record when the thread is read: by the session as above, and by the
// history op and the info op (a page opening the agent) after they answered, when nothing read it in the last 15 s. A
// change to the record reloads the views; and each such message is told to the app once (`said`, for turn triggers:
// by the session when it runs, else by the op that found it). Before each turn gbot's doctor is asked (no network;
// kept 30 s), so a broken session is a failed turn saying what to do (grok-bot-cli #147: relaunch the app while its
// computer is awake; #143: descriptor v3). Seen live: the gateway refuses gbot ("417") from about half a minute after
// the bot last did something, while the doctor still says the session is usable; gbot() wakes it then. A read that
// fails is logged only when a person must do something, or after five in a row.
//
// None: a terminal (Grok Bot's TUI is its desktop app: info's resume opens it), token use (gbot says none), strangers,
// holder, the follow op. Its instructions are Grok Bot's own: the bot runs elsewhere and cannot run `pagent`, so it
// gets no system prompt or skills from the app; a message's "(from …)" line says who is talking.
// Versions: grok-bot-cli 0.12.4 (with #143), Grok Bot 0.68; checked live again on 0.75 (2026-10-22).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UIMessageChunk } from "ai";
import { loadSession, saveSession } from "./lib/common.ts";
import type { AgentInput, Describe, Op } from "./lib/contract.ts";
import { doctor, gbot, GbotError, said } from "./lib/gbot.ts";
import { cardCall, cardOf, entriesOf, historyOf, isUser, keep, lastOf, readRecord, recordFile, Reply, trajectoryOf, untold, withoutHeads, wordsIn, entryText, type Entry, type Seen } from "./lib/grokbot-thread.ts";
import { askApp } from "./lib/permission.ts";

type Input = AgentInput & { op: Op; from?: string; to?: string };

const out = (o: UIMessageChunk | Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
const exit = (code: number) => process.stdout.write("", () => process.exit(code));
const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : d);
/** "30s", "10m", "1h" in ms; 0: not one. */
const spanMs = (v: unknown) => {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/.exec(String(v).trim());
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] : 0;
};

/** The bot the agent is, as declared. */
const declared = (input: Input) => (typeof input.options?.bot === "string" && input.options.bot.trim() ? input.options.bot.trim() : null);
/** The bot the quick ops read: the one the agent's session has open, else the one it last had (its id). */
const botOf = (input: Input): string | null => input.thread ?? loadSession(input.stateDir, input.seedSession);
/** gbot's correlation id is 1-128 of [A-Za-z0-9_.:-]: the run's id. */
const corrOf = (run: string) => run.replace(/[^\w.:-]/g, "-").slice(0, 128) || "run";

// ---------------------------------------------------------------- reading the thread

/** The record's entries as last seen, by id (what a read of the thread compares against). */
const knownOf = (file: string) => new Map(entriesOf(readRecord(file)).map(({ e }) => [e.id, JSON.stringify(e)]));

/**
 * Read the end of the bot's thread and keep what is new or changed: those entries, in order (isNew: first seen now). A
 * full page with nothing known in it is a gap: the most gbot reads (200) instead.
 */
async function sync(bot: string, file: string, known: Map<string, string>, limit = 40, timeoutMs?: number): Promise<{ e: Entry; isNew: boolean }[]> {
  const r = await gbot(["thread", bot, "--json", "--no-history", "--limit", String(limit)], timeoutMs ? { timeoutMs } : {});
  const entries: Entry[] = (Array.isArray(r?.transcript?.entries) ? r.transcript.entries : []).filter((e: any) => e && typeof e === "object" && typeof e.id === "string");
  if (limit < 200 && entries.length >= limit && known.size && !entries.some((e) => known.has(e.id))) return sync(bot, file, known, 200, timeoutMs);
  const t = Date.now();
  const changed: { e: Entry; isNew: boolean }[] = [];
  for (const e of entries) {
    const json = JSON.stringify(e);
    if (known.get(e.id) === json) continue;
    changed.push({ e, isNew: !known.has(e.id) });
    known.set(e.id, json);
    keep(file, { t, e });
  }
  return changed;
}

/** When the thread was last read (by anyone: the session, a quick op), so a quick op does not read it again at once. */
const readStamp = (stateDir: string) => join(stateDir, "grokbot-read.json");
const readNow = (stateDir: string) => writeFileSync(readStamp(stateDir), JSON.stringify({ at: Date.now() }) + "\n");

/**
 * Tell the app what the bot said outside any turn (`said`, for turn triggers), once each: what the record has that no
 * turn had and nothing told yet. A record that never told anything (new, or from before this) starts now.
 */
function report(file: string) {
  const record = readRecord(file);
  const said = untold(record);
  if (!said) return keep(file, { t: Date.now(), told: wordsIn(record) });
  if (!said.length) return;
  keep(file, { t: Date.now(), told: said.map((s) => s.id) });
  for (const s of said) out({ type: "said", ...s });
}

/** Is a turn in progress, as the record has it (a message sent, its end not yet)? */
const inTurn = (record: Seen[]) => {
  const sent = record.findLast((s) => "sent" in s);
  return !!sent && "sent" in sent && !record.some((s) => "end" in s && s.end.run === sent.sent.run);
};

/**
 * A quick op's look at the thread, after its answer (the history; a page opening the agent): unless it was read in the
 * last 15 s, read it once (waking its computer if it sleeps), so what the bot said since reaches the record (which
 * reloads the views) and the app: told here, unless the agent's session is in a turn (it tells what is not the turn's).
 * Never before the agent has a bot. Asleep is not worth a line in the log; what a person must do is.
 */
async function freshen(input: Input) {
  const bot = botOf(input);
  if (!bot) return;
  try {
    if (Date.now() - JSON.parse(readFileSync(readStamp(input.stateDir), "utf8")).at < 15_000) return;
  } catch {}
  const file = recordFile(input.stateDir, bot);
  try {
    readNow(input.stateDir);
    await sync(bot, file, knownOf(file), existsSync(file) ? 40 : 200, 8_000);
  } catch (e) {
    if (!(e instanceof GbotError && e.kind === "gateway")) console.error(`grokbot: reading ${bot}'s thread: ${(e as Error).message}`);
  }
  if (existsSync(file) && !(input.thread && inTurn(readRecord(file)))) report(file);
}

/** The declared bot, by name or id (made when it is not there and the declaration says createBot). */
async function resolveBot(name: string, create: boolean): Promise<{ id: string; name: string; kind: string }> {
  try {
    return await gbot(["bots", "get", name, "--json"]);
  } catch (e) {
    if (!(e instanceof GbotError && e.kind === "no-bot") || !create) throw e;
    console.error(`grokbot: no bot "${name}": making it (createBot)`);
    return gbot(["bots", "create", "--name", name, "--json"]);
  }
}

// ---------------------------------------------------------------- the session

async function sessionOp(input: Input, commands: AsyncIterator<string>) {
  const failed = (errorText: string) => (out({ type: "failed", errorText: said(errorText) }), exit(2));
  const name = declared(input);
  if (!name) return failed('a Grok Bot agent says which bot it is: { cli: "grokbot", bot: "<its name or id>" } (`gbot bots list` shows them; createBot: true makes it)');
  const broken = await doctor(true);
  if (broken) return failed(broken);
  let bot: { id: string; name: string };
  try {
    bot = await resolveBot(name, input.options?.createBot === true);
    if (typeof bot?.id !== "string") throw new Error(`gbot said no bot for "${name}"`);
  } catch (e) {
    return failed((e as Error).message);
  }
  saveSession(input.stateDir, bot.id);
  const file = recordFile(input.stateDir, bot.id);
  const known = knownOf(file);
  const decided = new Set(readRecord(file).flatMap((s) => ("decided" in s ? [s.decided.entryId] : [])));
  try {
    await sync(bot.id, file, known, existsSync(file) ? 40 : 200);
    readNow(input.stateDir);
  } catch (e) {
    return failed((e as Error).message);
  }
  out({ type: "ready", threadId: bot.id });
  report(file); // what it said while nobody read its thread

  const o = input.options ?? {};
  const QUIET = num(process.env.GROKBOT_QUIET_MS, num(o.quietSeconds, 20) * 1000);
  const POLL = num(process.env.GROKBOT_POLL_MS, 1000);
  const IDLE = num(process.env.GROKBOT_IDLE_MS, 15_000);
  const LIMIT = num(o.waitMinutes, 30) * 60_000;
  const EXPECT = num(process.env.GROKBOT_EXPECT_MS, 10 * 60_000); // after a turn, or its last words: more may come
  const FOLLOW = o.follow === undefined ? 0 : Math.max(spanMs(o.follow), num(process.env.GROKBOT_FOLLOW_MIN_MS, 60_000));
  if (o.follow !== undefined && !spanMs(o.follow)) console.error(`grokbot: follow ${JSON.stringify(o.follow)} is not a span ("10m", "1h"): ${bot.name} is followed every minute`);

  type Ask = { run: string; message: string; meta?: unknown };
  type Turn = { run: string; corr: string; messageId?: string; requestId?: string; userSeen: boolean; started: number; activity: number; reply: Reply; lines: string[]; cards: Set<string>; failures: number };
  const queue: Ask[] = [];
  let turn = null as Turn | null;
  let starting = false;
  const emit = (c: Record<string, unknown>) => {
    const line = JSON.stringify(c);
    turn?.lines.push(line);
    process.stdout.write(line + "\n");
  };

  // ---- approval cards: a permission request each, while it is pending
  const asking = new Map<string, AbortController>(); // entry id → the request to the app
  const dismissed = new Set<string>(); // cards a stopped turn left to Grok Bot's own app
  const askCard = async (entry: Entry) => {
    const card = cardOf(entry)!;
    const ctl = new AbortController();
    asking.set(card.entryId, ctl);
    const c = cardCall(card);
    try {
      const r = await askApp(input.permissionUrl!, { tool: c.tool, input: card.details, meta: c.meta, detail: c.detail }, ctl.signal);
      if (!r.decision || ctl.signal.aborted) return; // nobody decides here: Grok Bot's own app does
      const decision = r.decision.allow ? "accept" : "decline";
      let error: string | undefined;
      try {
        await gbot(["approvals", "respond", "--target", bot.id, "--entry-id", card.entryId, "--request-id", card.requestId, "--decision", decision, "--json"]);
      } catch (e) {
        error = (e as Error).message;
      }
      decided.add(card.entryId);
      keep(file, { t: Date.now(), decided: { entryId: card.entryId, requestId: card.requestId, decision, ...(error ? { error } : {}) } });
      if (turn?.cards.has(card.entryId)) (turn.reply.decided(card.entryId, decision, error), (turn.activity = Date.now()));
      soon(0);
    } catch {
      // stopped (the card went away), or the app is gone: the card stays Grok Bot's
    } finally {
      asking.delete(card.entryId);
    }
  };
  const cards = (e: Entry) => {
    const card = cardOf(e);
    if (!card) return;
    if (card.status !== "pending") return asking.get(e.id)?.abort(); // decided in Grok Bot's own app
    if (!input.permissionUrl || asking.has(e.id) || decided.has(e.id) || dismissed.has(e.id)) return;
    void askCard(e);
  };

  // ---- following the thread
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let again = false;
  let quietPolls = 0;
  let lately = 0; // when something last happened: a turn ended, the thread had something new
  let failing = 0; // reads that failed in a row
  let logged = ""; // what the log last said of them
  const soon = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    if (polling) return void (again = true);
    polling = true;
    let changed: { e: Entry; isNew: boolean }[] = [];
    let failure: Error | null = null;
    try {
      changed = await sync(bot.id, file, known);
      readNow(input.stateDir);
    } catch (e) {
      failure = e as Error;
    }
    polling = false;
    const t = turn;
    if (failure) {
      // Its computer asleep, or starting (gbot() wakes it): the next read is likely fine. Said in the log when a person
      // must do something, or once it kept failing; a turn fails after five in a row.
      const someone = !(failure instanceof GbotError && failure.kind === "gateway");
      if ((someone || ++failing === 5) && logged !== failure.message) console.error(`grokbot: reading ${bot.name}'s thread${someone ? "" : " failed 5 times in a row"}: ${(logged = failure.message)}`);
      if (t && ++t.failures >= 5) endTurn("failed", `${(await doctor(true)) ?? failure.message} (its reply, when it comes, shows in the history)`);
    } else {
      failing = 0;
      logged = "";
      if (t) t.failures = 0;
    }
    const told: string[] = [];
    for (const { e, isNew } of changed) {
      if (t && turn === t && route(t, e, isNew)) told.push(e.id);
      cards(e);
    }
    if (told.length) keep(file, { t: Date.now(), told });
    if (changed.length) report(file);
    if (turn === t && t) check(t);
    if (changed.length) lately = Date.now();
    quietPolls = changed.length ? 0 : quietPolls + 1;
    const base = turn ? POLL : IDLE;
    // In a turn, and for a while after anything happened: often. Then every `follow`, or not until the next turn.
    const wait = turn || Date.now() - lately < EXPECT ? Math.min(base * 1.5 ** quietPolls, base * (turn ? 3 : 4)) : FOLLOW;
    if (again) soon(0);
    else if (wait) soon(wait);
    again = false;
  };

  /**
   * An entry, for the turn in progress: its message (the request its replies answer), or the bot's reply to it. true:
   * it is the turn's (the app hears of it with the turn).
   */
  const route = (t: Turn, e: Entry, isNew: boolean): boolean => {
    if (isUser(e)) {
      if (!t.userSeen && (withoutHeads(entryText(e)).corr === t.corr || e.id === t.messageId)) {
        t.userSeen = true;
        if (typeof e.requestId === "string") t.requestId = e.requestId;
      }
      return false;
    }
    // The bot's replies carry the request they answer; what carries none (an event: a schedule it made), what is new.
    if (typeof e.requestId === "string" && t.requestId ? e.requestId !== t.requestId : !isNew) return false;
    if (cardOf(e)) t.cards.add(e.id);
    t.reply.entry(e);
    t.activity = Date.now();
    if (/^(turn|run|request)[-_]?(end|ended|complete|completed|done|finished|failed|error)$|^error$/i.test(String(e.kind ?? ""))) {
      const failed = /fail|error/i.test(String(e.kind)) || /fail|error/i.test(String(e.status ?? ""));
      endTurn(failed ? "failed" : "completed", failed ? entryText(e) || String(e.kind) : undefined);
    }
    return true;
  };

  /** Is the turn over? Said something, then quiet (no card waiting); or did things, then quiet for longer; or too long. */
  const check = (t: Turn) => {
    const quiet = Date.now() - t.activity;
    const said = t.reply.parts.some((p) => p.type === "text");
    if (!t.reply.waiting() && !t.reply.streaming() && ((said && quiet >= QUIET) || (t.reply.parts.length && quiet >= 3 * QUIET))) return endTurn("completed");
    if (Date.now() - t.started >= LIMIT && !t.reply.waiting()) endTurn("timeout", `Grok Bot has not finished in ${Math.round(LIMIT / 60_000)} minutes; pagent stopped waiting (what it says later shows in the history)`);
  };

  const endTurn = (status: string, errorText?: string) => {
    const t = turn;
    if (!t) return;
    if (status === "interrupted") {
      for (const id of t.cards) {
        if (!asking.has(id)) continue;
        dismissed.add(id);
        asking.get(id)!.abort();
      }
    }
    if (errorText) emit({ type: "error", errorText });
    emit({ type: "turn-end", turnId: t.run, status, text: t.reply.answer.trim() });
    keep(file, { t: Date.now(), end: { run: t.run, status } });
    turn = null;
    quietPolls = 0;
    lately = Date.now();
    soon(IDLE);
    void next();
  };

  const next = async () => {
    if (turn || starting || !queue.length) return;
    starting = true;
    const ask = queue.shift()!;
    try {
      const broken = await doctor();
      if (broken) return out({ type: "ask-failed", run: ask.run, errorText: said(broken) });
      const corr = corrOf(ask.run);
      let receipt: any;
      try {
        receipt = await gbot(["send", bot.id, "--json", "--no-history", "--correlation-id", corr, "--", ask.message], { timeoutMs: 90_000 });
      } catch (e) {
        const why = e instanceof GbotError && e.kind === "gateway" ? ((await doctor(true)) ?? e.message) : (e as Error).message;
        return out({ type: "ask-failed", run: ask.run, errorText: said(why) });
      }
      // gbot 0.12.4 says no messageId (delivery "unknown") for every message: the thread shows it by its correlation id.
      const messageId = typeof receipt?.messageId === "string" ? receipt.messageId : undefined;
      keep(file, { t: Date.now(), sent: { run: ask.run, corr, text: ask.message, ...(messageId ? { messageId } : {}) } });
      const now = Date.now();
      turn = { run: ask.run, corr, ...(messageId ? { messageId } : {}), userSeen: false, started: now, activity: now, reply: new Reply((c) => emit(c as Record<string, unknown>)), lines: [], cards: new Set(), failures: 0 };
      emit({ type: "turn", turnId: ask.run });
      // Its id in the history is the run's (lib/grokbot-thread.ts, turnsIn): the app keeps its own under it (core ids.ts).
      emit({ type: "user", turnId: ask.run, id: ask.run, text: ask.message, clientId: ask.run, meta: ask.meta });
      quietPolls = 0;
      soon(Math.min(POLL, 500));
    } finally {
      starting = false;
      if (!turn) void next();
    }
  };

  // What is pending already (a card from before the session) asks now; the thread was just read: it is read again with
  // the first turn, or after `follow`.
  for (const { e } of entriesOf(readRecord(file))) cards(e);
  if (FOLLOW) soon(FOLLOW);

  for (;;) {
    const line = await commands.next();
    if (line.done) break; // the daemon closed stdin: it is going away
    let c: any;
    try {
      c = JSON.parse(line.value);
    } catch {
      continue;
    }
    if (c.op === "ask") {
      queue.push({ run: String(c.run), message: String(c.message ?? ""), meta: c.meta });
      void next();
    } else if (c.op === "interrupt") {
      // gbot cannot stop Grok Bot: pagent stops waiting; what was queued is never sent.
      for (const a of queue.splice(0)) out({ type: "ask-failed", run: a.run, errorText: "stopped before it was sent to Grok Bot" });
      endTurn("interrupted");
    } else if (c.op === "state") {
      out({ type: "ready", threadId: bot.id });
      for (const l of turn?.lines ?? []) process.stdout.write(l + "\n");
    } else if (c.op === "stop") break;
  }
  clearTimeout(timer);
  for (const ctl of asking.values()) ctl.abort();
  exit(0);
}

// ---------------------------------------------------------------- the quick ops

async function historyOp(input: Input) {
  const bot = botOf(input);
  const file = bot ? recordFile(input.stateDir, bot) : null;
  out({ type: "history", messages: file ? historyOf(readRecord(file)) : [], ...(file && existsSync(file) ? { file } : {}) });
  await freshen(input);
}

function lastOp(input: Input) {
  const bot = botOf(input);
  const file = bot ? recordFile(input.stateDir, bot) : null;
  out({ type: "last", ...(file ? lastOf(readRecord(file)) : { text: null, at: null, lastAt: null }), title: null, file: file && existsSync(file) ? file : null });
}

function trajectoryOp(input: Input) {
  const bot = botOf(input);
  const file = bot ? recordFile(input.stateDir, bot) : null;
  out({ type: "trajectory", records: file ? trajectoryOf(readRecord(file)) : [], ...(file && existsSync(file) ? { file } : {}) });
}

/** The bot, and how to reach it outside the app: Grok Bot's own app (it opens on its bots; pick this one). */
async function infoOp(input: Input) {
  const bot = botOf(input);
  out({ type: "info", sessionId: bot, resume: bot && platform() === "darwin" ? `open -a "Grok Bot"` : null });
  await freshen(input);
}

/** The agent's folder moved: its bot is the one it had (Grok Bot keys it by id), remembered in its state. */
function moveOp(input: Input) {
  const had = loadSession(input.stateDir, input.seedSession);
  if (had) saveSession(input.stateDir, had);
  out({ type: "moved", sessions: had ? 1 : 0 });
}

function describeOp() {
  out({ type: "describe", harness: { id: "grokbot", title: "Grok Bot" }, turns: "thread", ops: ["last", "info", "trajectory", "move"], interject: false, sessions: "agent" } satisfies Describe);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next();
const input = JSON.parse(first.done ? "{}" : first.value) as Input;
if (input.op === "describe") describeOp();
else if (input.op === "session") await sessionOp(input, lines);
else if (input.op === "history") await historyOp(input);
else if (input.op === "last") lastOp(input);
else if (input.op === "trajectory") trajectoryOp(input);
else if (input.op === "info") await infoOp(input);
else if (input.op === "move") moveOp(input);
else out({ type: "error", errorText: `Grok Bot has no op ${input.op}` });
if (input.op !== "session") exit(0);
