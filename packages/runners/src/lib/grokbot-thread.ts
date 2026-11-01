// A Grok Bot bot's thread (runner:grokbot), as the app shows it: live, as a turn's UIMessageChunks; afterwards, from what
// the runner kept of it (its record), as UIMessages and as a trajectory. One state machine (Reply) for both, as the ACP
// runner has, so the history is what the conversation showed.
//
// The thread is what `gbot thread --json` gives: the gateway's transcript entries, which gbot passes on as they are.
// As seen live (Grok Bot 0.68, grok-bot-cli 0.12.4 with #143, 2026-10-20), each { kind, id, timestampMs, seq, requestId? }:
//   kind "message", role "user", content, isStreaming, clientNonce, requestId: a message to the bot (gbot's [gbot …]
//     head first), requestId the request its replies answer; the bot may add reactions: [{ emoji, by }] later;
//   kind "send-message", message: { type: "text", content }, requestId: the bot says something, whole (the replies seen
//     came a message at a time); or an approval card (gbot's grok-approvals.js; none came up live): message.type
//     "auto-review-approval" (message.approval) or "local-tool-permission" (message.ask), each { requestId, status:
//     "pending" | …, command?, action?, target?, reason?, summary? … };
//   kind "event", event: { type: "automation-changed", action: "created", automationId, automationName }, no requestId: a
//     schedule it made (shown as a step).
// Not in the thread: its steps (an X search, a command it ran on the user's Mac: neither showed, in the tail nor in the
// rooted thread), a request's end, tokens. What is read besides, in case: a message of the bot's that says
// isStreaming grows as a stream; "tool-call" and the like (named in gbot's tests) as steps by their usual fields; any other
// kind is kept in the record and shown as nothing. Times: timestampMs (else createdAt …, else when first seen).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UIMessage, UIMessageChunk } from "ai";
import { commonOf, meta, obj, stepsOf, type ToolMeta } from "./tools.ts";
import { byTime, ms, turnsOf, type TrajectoryRecord } from "./trajectory.ts";

export type Entry = Record<string, any> & { id: string; kind?: string };
type Part = UIMessage["parts"][number];
type Emit = (c: UIMessageChunk | Record<string, unknown>) => void;

// ---------------------------------------------------------------- reading an entry

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** An entry's text, as gbot reads it (transcript.js entryText). */
export function entryText(e: any): string {
  if (!e || typeof e !== "object") return "";
  const direct = e.text || e.prompt || e.message;
  if (typeof direct === "string" && direct) return direct;
  const content = e.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? p.text || p.content || "" : "")).filter(Boolean).join("\n");
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  if (e.message && typeof e.message === "object" && typeof e.message.content === "string") return e.message.content;
  if (e.message && typeof e.message === "object" && typeof e.message.text === "string") return e.message.text;
  return typeof e.preview === "string" ? e.preview : "";
}

/** What gbot puts at the head of a message it sends: its envelope ([gbot msg=… corr=…]), a Codex sender's line. */
const HEADS = /^(?:\[gbot msg=\S+ corr=(\S+)(?: reply-to=\S+)? hop=\d+ from=[^\]\n]*\]|\[from Codex thread [^\n]*\])\n/;
export function withoutHeads(text: string): { text: string; corr?: string } {
  let corr: string | undefined;
  for (let m; (m = HEADS.exec(text)); text = text.slice(m[0].length)) corr ??= m[1];
  return { text, ...(corr ? { corr } : {}) };
}

export const isUser = (e: Entry) => e.kind === "user" || e.role === "user" || e.kind === "user-message" || e.kind === "prompt";

/** An approval card, pending or not (gbot's grok-approvals.js reads the same). */
export type Card = { entryId: string; requestId: string; type: string; status: string; details: Record<string, string> };
export function cardOf(e: Entry): Card | null {
  if (e.kind !== "send-message") return null;
  const type = e.message?.type;
  const card = type === "auto-review-approval" ? e.message.approval : type === "local-tool-permission" ? e.message.ask : null;
  if (!card || typeof card !== "object" || typeof card.requestId !== "string") return null;
  const details: Record<string, string> = {};
  for (const k of ["reason", "command", "summary", "action", "description", "target", "machineId", "surface", "workingDirectory"]) if (typeof card[k] === "string") details[k] = card[k];
  return { entryId: e.id, requestId: card.requestId, type, status: String(card.status ?? "pending"), details };
}

/** What a card asks to do, as a call: its name, what it does, the words of the permission card. */
export function cardCall(c: Card): { tool: string; meta: ToolMeta; detail: string } {
  const d = c.details;
  const command = d.command ?? (/command|shell|exec|run/i.test(d.action ?? "") ? d.target : undefined);
  const tool = d.action || (c.type === "auto-review-approval" ? "approval" : "local tool");
  const lines = [command ?? d.target, d.summary, d.description, d.reason, d.machineId && `on ${d.machineId}`, d.workingDirectory && `in ${d.workingDirectory}`].filter(Boolean);
  return { tool, meta: command ? meta("command", { command }) : meta("other"), detail: lines.join("\n") || JSON.stringify(d) };
}

const DECIDED: Record<string, "approved" | "declined"> = { approved: "approved", accepted: "approved", allowed: "approved", "allow-once": "approved", denied: "declined", declined: "declined", rejected: "declined", deny: "declined" };

/** A step the bot takes (a tool call it shows), by what such entries usually say. result: the call a result entry is of. */
export function toolOf(e: Entry): { id: string; name: string; input: unknown; output?: unknown; error?: string; result?: string } | null {
  if (e.kind === "event" && typeof e.event?.type === "string") {
    // Something it did that the thread notes (seen live: { type: "automation-changed", action: "created", automationId,
    // automationName }, a schedule it made): a step, done.
    const { type, ...rest } = e.event;
    return { id: e.id, name: type, input: rest, output: typeof rest.action === "string" ? rest.action : "done" };
  }
  if (!e.kind || isUser(e) || e.kind === "send-message" || !/tool|call|search|browse|computer|shell|command|function/i.test(e.kind)) return null;
  const m = obj(e.message);
  const result = /result|output|response/i.test(e.kind) ? str(e.toolCallId) || str(e.callId) || str(m.toolCallId) : "";
  const name = str(e.name) || str(e.toolName) || str(e.tool) || str(m.name) || str(m.toolName) || e.kind;
  const input = e.input ?? e.args ?? e.arguments ?? e.params ?? m.input ?? m.args ?? m.arguments ?? {};
  const output = e.output ?? e.result ?? m.output ?? m.result;
  const error = typeof e.error === "string" ? e.error : e.status === "failed" || e.status === "error" ? "failed" : undefined;
  return { id: str(e.toolCallId) || str(e.callId) || e.id, name, input, ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}), ...(result ? { result } : {}) };
}

/** Grok Bot's tools, as what they do (tools.ts): its X search first. A name it does not know: what its input says. */
export function grokTool(name: string, input: unknown): ToolMeta {
  const c = commonOf(input);
  const n = name.toLowerCase();
  const query = c.query ?? (typeof c.o.q === "string" ? c.o.q : undefined) ?? (typeof c.o.search === "string" ? c.o.search : undefined);
  if (/(^|[_\W])x[_-]?(keyword|semantic)?[_-]?search|search[_-]?x\b|twitter|x_posts|x_user/.test(n)) return meta("webSearch", { query });
  if (/web[_-]?search|search[_-]?web|google/.test(n)) return meta("webSearch", { query });
  if (/browse|open[_-]?url|fetch|read[_-]?url|web[_-]?page/.test(n)) return meta("web", { url: c.url });
  if (/shell|bash|terminal|run[_-]?command|exec|command/.test(n)) return meta("command", { command: c.command });
  if (/todo|plan/.test(n) && (Array.isArray(c.o.todos) || Array.isArray(c.o.steps))) return meta("steps", { steps: { set: stepsOf(c.o.todos ?? c.o.steps) } });
  if (/read[_-]?file|view[_-]?file/.test(n)) return meta("read", { files: c.files });
  if (/write[_-]?file|create[_-]?file/.test(n)) return meta("write", { files: c.files });
  if (/edit[_-]?file|str_replace/.test(n)) return meta("edit", { files: c.files });
  if (/search/.test(n)) return meta("webSearch", { query });
  if (c.command) return meta("command", { command: c.command });
  if (c.url) return meta("web", { url: c.url });
  if (query) return meta("webSearch", { query });
  return meta("other"); // computer use (click, type, screenshot …) and the rest: their name says it
}

// ---------------------------------------------------------------- a reply

/**
 * The bot's side of a turn (or of what it said on its own): entries in, chunks out (live) and parts (history). An entry
 * seen again with something new (a card decided, a call's output) updates what it made. answer: its texts after its
 * last step.
 */
export class Reply {
  readonly parts: Part[] = [];
  answer = "";
  private seen = new Map<string, string>(); // entry id → the entry as last seen
  private calls = new Map<string, { card: boolean; done: boolean }>(); // the calls shown (steps, cards), by id
  private emit: Emit;

  constructor(emit: Emit = () => {}) {
    this.emit = emit;
  }

  private call(id: string, name: string, input: unknown, m: ToolMeta, card = false, note = false) {
    if (this.calls.has(id)) return;
    this.calls.set(id, { card, done: false });
    this.emit({ type: "tool-input-start", toolCallId: id, toolName: name, dynamic: true, toolMetadata: m });
    this.emit({ type: "tool-input-available", toolCallId: id, toolName: name, input, dynamic: true, toolMetadata: m });
    this.parts.push({ type: "dynamic-tool", toolName: name, toolCallId: id, state: "input-available", input, toolMetadata: m } as Part);
    if (!note) this.answer = ""; // a note (an event: a schedule it made) leaves the answer as it was
  }

  private finish(id: string, output: unknown, error?: string) {
    const c = this.calls.get(id);
    const p = this.parts.find((x: any) => x.type === "dynamic-tool" && x.toolCallId === id) as any;
    if (!c || c.done || !p) return;
    c.done = true;
    if (error) {
      this.emit({ type: "tool-output-error", toolCallId: id, errorText: error, dynamic: true });
      Object.assign(p, { state: "output-error", errorText: error });
    } else {
      this.emit({ type: "tool-output-available", toolCallId: id, output, dynamic: true, toolMetadata: p.toolMetadata });
      Object.assign(p, { state: "output-available", output });
    }
  }

  /**
   * A message's text: whole when it shows (send-message), or growing while the entry says isStreaming (the thread's
   * messages carry that flag): its block stays open, each new end of it a delta, until the entry stops streaming.
   */
  private texts = new Map<string, { part: any; said: string; open: boolean; before: string }>();
  private say(kind: "text" | "reasoning", id: string, text: string, streaming: boolean) {
    const t = this.texts.get(id);
    if (!t) {
      if (!text.trim() && !streaming) return;
      const part = { type: kind, text, state: streaming ? "streaming" : "done" };
      this.texts.set(id, { part, said: text, open: true, before: this.answer });
      this.emit({ type: `${kind}-start`, id });
      if (text) this.emit({ type: `${kind}-delta`, id, delta: text });
      this.parts.push(part as Part);
    } else if (text !== t.said) {
      // More of it (a message that is said again otherwise, rewritten, shows as it ends up in the history).
      if (t.open && text.startsWith(t.said)) this.emit({ type: `${kind}-delta`, id, delta: text.slice(t.said.length) });
      t.said = t.part.text = text;
    }
    const now = this.texts.get(id)!;
    if (kind === "text" && this.parts.at(-1) === now.part) this.answer = now.before ? `${now.before}\n\n${now.said}` : now.said;
    if (now.open && !streaming) {
      now.open = false;
      now.part.state = "done";
      this.emit({ type: `${kind}-end`, id });
    }
  }

  /** Is a message of its still being written? */
  streaming(): boolean {
    return [...this.texts.values()].some((t) => t.open);
  }

  /** An entry of the bot's (new, or seen again). */
  entry(e: Entry) {
    const json = JSON.stringify(e);
    if (this.seen.get(e.id) === json) return;
    this.seen.set(e.id, json);
    const card = cardOf(e);
    if (card) {
      const c = cardCall(card);
      this.call(e.id, c.tool, card.details, c.meta, true);
      const d = DECIDED[card.status];
      if (d) this.finish(e.id, d === "approved" ? "approved (once)" : undefined, d === "declined" ? "declined" : undefined);
      else if (card.status !== "pending") this.finish(e.id, undefined, card.status);
      return;
    }
    const t = toolOf(e);
    if (e.kind === "send-message" || (e.role === "assistant" && !t)) return this.say("text", `t-${e.id}`, entryText(e), e.isStreaming === true);
    if (/reason|think/i.test(String(e.kind ?? ""))) return this.say("reasoning", `r-${e.id}`, entryText(e), e.isStreaming === true);
    if (!t) return;
    if (t.result) return this.finish(t.result, t.output ?? entryText(e), t.error); // a result, of a call shown before
    this.call(t.id, t.name, t.input, grokTool(t.name, t.input), false, e.kind === "event");
    if (t.output !== undefined || t.error) this.finish(t.id, t.output, t.error);
  }

  /** The person decided a card in the app (the runner told Grok Bot): what came of it. */
  decided(entryId: string, decision: "accept" | "decline", error?: string) {
    this.finish(entryId, decision === "accept" ? "approved (once)" : undefined, error ?? (decision === "decline" ? "declined" : undefined));
  }

  /** Is one of its cards waiting for someone's decision? */
  waiting(): boolean {
    return [...this.calls.values()].some((c) => c.card && !c.done);
  }
}

// ---------------------------------------------------------------- the record

/**
 * What the runner keeps of a bot's thread (<stateDir>/grokbot/<bot>.jsonl): each entry as it saw it (again when it
 * changed: a card decided), what it sent (the run, its words as the app had them, the correlation id gbot put at their
 * head, gbot's id for the message), how each turn ended, what the person decided on a card, and the entries the app
 * was told of (told: a turn's, or what the bot said outside one, reported as `said`).
 */
export type Seen =
  | { t: number; e: Entry }
  | { t: number; sent: { run: string; corr: string; text: string; messageId?: string } }
  | { t: number; end: { run: string; status: string } }
  | { t: number; decided: { entryId: string; requestId: string; decision: "accept" | "decline"; error?: string } }
  | { t: number; told: string[] };

export const recordFile = (stateDir: string, bot: string) => join(stateDir, "grokbot", `${bot.replace(/[^\w.-]/g, "_")}.jsonl`);

export function keep(file: string, seen: Seen) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(seen) + "\n");
}

export function readRecord(file: string): Seen[] {
  if (!existsSync(file)) return [];
  const out: Seen[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // a line cut short
  }
  return out;
}

/** The thread as the record has it: each entry once (as last seen, where first seen), when it was first and last seen. */
export function entriesOf(record: Seen[]): { e: Entry; t: number; u: number }[] {
  const order = new Map<string, number>();
  const last = new Map<string, { e: Entry; t: number; u: number }>();
  for (const s of record) {
    if (!("e" in s) || typeof s.e?.id !== "string") continue;
    if (!order.has(s.e.id)) order.set(s.e.id, order.size);
    last.set(s.e.id, { e: s.e, t: last.get(s.e.id)?.t ?? s.t, u: s.t });
  }
  return [...last.entries()].sort((a, b) => order.get(a[0])! - order.get(b[0])!).map(([, v]) => v);
}

/** When an entry happened: its own time when it says one, else when the runner first saw it. */
const timeOf = (e: Entry, seen: number) => ms(e.timestampMs ?? e.createdAt ?? e.created_at ?? e.timestamp ?? e.time ?? e.at ?? e.ts) ?? seen;

/**
 * A turn of the record. user: the message, the app's (id: its run's, the id the runner told the app it has; text: its
 * words as the app had them; run) or one written to the bot elsewhere (its entry's id, its words).
 */
type Turn = { user: { id: string; text: string; t: number; run?: string } | null; requestId?: string; entries: { e: Entry; t: number; u: number }[]; end?: { t: number; status: string } };

/** The record as turns: each message to the bot, then what the bot did for it; what it did on its own, a turn with no message. */
function turnsIn(record: Seen[]): Turn[] {
  const sent = record.flatMap((s) => ("sent" in s ? [s.sent] : []));
  const ends = new Map(record.flatMap((s) => ("end" in s ? [[s.end.run, { t: s.t, status: s.end.status }] as const] : [])));
  const turns: Turn[] = [];
  for (const { e, t, u } of entriesOf(record)) {
    const requestId = typeof e.requestId === "string" ? e.requestId : undefined;
    if (isUser(e)) {
      const { text, corr } = withoutHeads(entryText(e));
      const mine = sent.find((s) => (corr && s.corr === corr) || (s.messageId && s.messageId === e.id));
      const end = mine && ends.get(mine.run);
      const user = mine ? { id: mine.run, text: mine.text, t: timeOf(e, t), run: mine.run } : { id: e.id, text, t: timeOf(e, t) };
      turns.push({ user, ...(requestId ? { requestId } : {}), entries: [], ...(end ? { end } : {}) });
      continue;
    }
    // What answers another request than the last message's (the bot on its own: a schedule, a late reply) is its own.
    const cur = turns.at(-1);
    if (!cur || (requestId && requestId !== cur.requestId && (cur.user || cur.requestId))) turns.push({ user: null, ...(requestId ? { requestId } : {}), entries: [] });
    turns.at(-1)!.entries.push({ e, t: timeOf(e, t), u: u > t ? u : timeOf(e, t) }); // u: when it last changed
  }
  return turns;
}

type Decisions = Map<string, { decision: "accept" | "decline"; error?: string }>;
const decisionsOf = (record: Seen[]): Decisions => new Map(record.flatMap((s) => ("decided" in s ? [[s.decided.entryId, s.decided] as const] : [])));

function replyOf(turn: Turn, decisions: Decisions): Reply {
  const reply = new Reply();
  for (const { e } of turn.entries) {
    reply.entry(e);
    const d = decisions.get(e.id);
    if (d && cardOf(e)?.status === "pending") reply.decided(e.id, d.decision, d.error);
  }
  return reply;
}

/** The conversation: each message to the bot, then its reply (what it said on its own: a reply with no message before it). */
export function historyOf(record: Seen[]): UIMessage[] {
  const decisions = decisionsOf(record);
  const messages: UIMessage[] = [];
  for (const turn of turnsIn(record)) {
    if (turn.user) messages.push({ id: turn.user.id, role: "user", parts: [{ type: "text", text: turn.user.text }] });
    const reply = replyOf(turn, decisions);
    if (reply.parts.length) messages.push({ id: `${turn.user?.id ?? turn.entries[0].e.id}:reply`, role: "assistant", parts: [{ type: "step-start" }, ...reply.parts] });
  }
  return messages;
}

/** Words of the bot's, whole: a message it said (not a card, not one still being written). */
const words = (e: Entry) => !isUser(e) && !cardOf(e) && (e.kind === "send-message" || e.role === "assistant") && e.isStreaming !== true && !!entryText(e).trim();

/**
 * What the bot said that the app was not told of (no turn had it, nothing reported it), each with the message it
 * answers when there is one (the app's, by its run; one written to it elsewhere); none, on its own (a schedule's). null:
 * the record never told anything (it is new, or from before this): what is in it is the past, and telling starts now.
 */
export function untold(record: Seen[]): { id: string; text: string; to?: { id: string; text: string; run?: string } }[] | null {
  const told = new Set<string>();
  let telling = false;
  for (const s of record) if ("told" in s) (telling = true), s.told.forEach((id) => told.add(id));
  if (!telling) return null;
  return turnsIn(record).flatMap((turn) =>
    turn.entries.filter(({ e }) => words(e) && !told.has(e.id)).map(({ e }) => ({ id: e.id, text: entryText(e), ...(turn.user ? { to: { id: turn.user.id, text: turn.user.text, ...(turn.user.run ? { run: turn.user.run } : {}) } } : {}) })),
  );
}

/** The bot's words in the record (what a record that never told anything starts by marking told). */
export const wordsIn = (record: Seen[]) => entriesOf(record).flatMap(({ e }) => (words(e) ? [e.id] : []));

/** Where it stopped: its last words, when it said them; when anything last happened. */
export function lastOf(record: Seen[]) {
  const turns = turnsIn(record);
  const lastAt = record.length ? new Date(record[record.length - 1].t).toISOString() : null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const said = replyOf(turns[i], new Map()).parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n\n").trim();
    if (said) return { text: said.slice(-4000), at: new Date(turns[i].entries.at(-1)?.t ?? turns[i].user?.t ?? 0).toISOString(), lastAt };
  }
  return { text: null, at: null, lastAt };
}

/**
 * The thread as a timeline (trajectory.ts), at the times the entries say or the runner saw them (never estimated): each
 * message to the bot, each thing it said (a point: Grok Bot shows whole messages), each step from when it was seen to
 * when its result was. Grok Bot says nothing of model requests or tokens.
 */
export function trajectoryOf(record: Seen[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  const said = new Map<string, Partial<TrajectoryRecord>>();
  for (const turn of turnsIn(record)) {
    const turnId = turn.user?.id ?? null;
    if (turn.user) records.push({ id: turn.user.id, turnId, kind: "user", start: turn.user.t, input: turn.user.text });
    const calls = new Map<string, TrajectoryRecord>();
    const callOf = (id: string, t: number, name: string, input: unknown) => {
      let r = calls.get(id);
      if (!r) records.push((r = { id, turnId, kind: "tool", start: t, name, input })), calls.set(id, r);
      return r;
    };
    for (const { e, t, u } of turn.entries) {
      const card = cardOf(e);
      const tool = card ? null : toolOf(e);
      if (card) {
        const r = callOf(e.id, t, cardCall(card).tool, card.details);
        if (card.status !== "pending") (r.end ??= u), (r.output = card.status);
      } else if (tool?.result) {
        const r = calls.get(tool.result);
        if (r) (r.end ??= t), (r.output = tool.output), tool.error && (r.error = true);
      } else if (tool) {
        const r = callOf(tool.id, t, tool.name, tool.input);
        if (tool.output !== undefined || tool.error) (r.end ??= u), (r.output = tool.output), tool.error && (r.error = true);
      } else if (e.kind === "send-message" || e.role === "assistant") {
        const text = entryText(e);
        if (text.trim()) records.push({ id: e.id, turnId, kind: "assistant", start: t, end: t, output: text });
      }
    }
    if (turnId && turn.end) said.set(turnId, { end: turn.end.t, status: turn.end.status });
  }
  return [...turnsOf(records, said), ...records].sort(byTime);
}
