// What an ACP runner keeps of each session it drives: every message it sent and every update the agent sent back, with
// the time it saw them (<stateDir>/acp/<session>.jsonl). ACP itself replays a session's conversation (session/load) but
// with no times, no usage and no ids for what the person said, and only by running the agent; this record is read
// without it. So the history, the trajectory (times as the runner saw them: never estimated), the token use and the
// last words of an ACP agent come from here, the same way for every ACP harness. What happened in the session outside
// the app (the harness's own CLI) is not in it: a runner with a better source (opencode's export) says so instead.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UIMessage } from "ai";
import type { AcpUpdate } from "./acp.ts";
import { outputOf, Reply, statusOf, toolNameOf } from "./acp-turns.ts";
import type { Classify } from "./tools.ts";
import { byTime, turnsOf, type TrajectoryRecord, type TrajectoryUsage } from "./trajectory.ts";
import type { SessionUsage } from "./usage.ts";

/** A turn's tokens, as the prompt's result said them (ACP's usage, or a harness's own _meta). */
export type TurnUsage = TrajectoryUsage & { model?: string };

export type Seen =
  | { t: number; user: { id: string; text: string } }
  | { t: number; u: AcpUpdate }
  | { t: number; end: { stopReason: string; usage?: TurnUsage } };

export const recordFile = (stateDir: string, session: string) => join(stateDir, "acp", `${session}.jsonl`);

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
    } catch {} // a line cut short (the runner was killed mid-write)
  }
  return out;
}

/** The tokens a prompt's result says (ACP's usage; Gemini CLI's _meta.quota), in pagent's shape (input without the cache). */
export function usageOfResult(r: any): TurnUsage | undefined {
  const u = r?.usage;
  if (u && typeof u === "object") {
    const cacheRead = Number(u.cachedReadTokens ?? 0);
    return { input: Math.max(0, Number(u.inputTokens ?? 0) - cacheRead), output: Number(u.outputTokens ?? 0), cacheRead, cacheWrite: Number(u.cachedWriteTokens ?? 0), ...(u.thoughtTokens ? { reasoning: Number(u.thoughtTokens) } : {}) };
  }
  const q = r?._meta?.quota?.token_count;
  if (q && typeof q === "object") {
    const model = r._meta.quota.model_usage?.at(-1)?.model;
    return { input: Number(q.input_tokens ?? 0), output: Number(q.output_tokens ?? 0), cacheRead: 0, cacheWrite: 0, ...(model ? { model } : {}) };
  }
  return undefined;
}

type Turn = { user: { id: string; text: string; t: number }; seen: { t: number; u: AcpUpdate }[]; end?: { t: number; stopReason: string; usage?: TurnUsage } };

/** The record as turns: each message, what came back, how it ended (none yet: going on, or the runner went away). */
function turnsIn(record: Seen[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of record) {
    if ("user" in s) turns.push({ user: { ...s.user, t: s.t }, seen: [] });
    else if ("u" in s) turns.at(-1)?.seen.push(s);
    else if ("end" in s && turns.length && !turns.at(-1)!.end) turns.at(-1)!.end = { t: s.t, ...s.end };
  }
  return turns;
}

/** The conversation: each message, then the agent's reply to it (one message, as the app showed it live). */
export function historyOf(record: Seen[], classify?: Classify): UIMessage[] {
  const messages: UIMessage[] = [];
  for (const turn of turnsIn(record)) {
    messages.push({ id: turn.user.id, role: "user", parts: [{ type: "text", text: turn.user.text }] });
    const reply = new Reply(undefined, classify);
    for (const s of turn.seen) reply.update(s.u, s.t);
    reply.end();
    if (reply.parts.length) messages.push({ id: `${turn.user.id}:reply`, role: "assistant", parts: [{ type: "step-start" }, ...reply.parts] });
  }
  return messages;
}

/** Where it stopped: its last reply's text, when it last talked. */
export function lastOf(record: Seen[], classify?: Classify) {
  const turns = turnsIn(record);
  let text: string | null = null;
  let at: string | null = null;
  for (let i = turns.length - 1; i >= 0 && !text; i--) {
    const reply = new Reply(undefined, classify);
    for (const s of turns[i].seen) reply.update(s.u, s.t);
    const said = reply.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n\n").trim();
    if (said) (text = said.slice(-4000)), (at = new Date(turns[i].end?.t ?? turns[i].seen.at(-1)?.t ?? turns[i].user.t).toISOString());
  }
  const lastT = record.length ? record[record.length - 1].t : null;
  return { text, at, lastAt: lastT ? new Date(lastT).toISOString() : null };
}

/**
 * The token use after one more thing seen: a turn's result adds its tokens, a usage_update says the context (`u` is
 * changed; null: none yet). ACP says turns, not requests: no `requests`.
 */
export function addUsage(u: SessionUsage | null, s: Seen): SessionUsage | null {
  const fresh = (): SessionUsage => ({ context: 0, window: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, compactions: 0, model: null, at: null });
  if ("end" in s && s.end.usage) {
    const e = s.end.usage;
    u ??= fresh();
    u.input += e.input;
    u.cacheRead += e.cacheRead;
    u.cacheWrite += e.cacheWrite;
    u.output += e.output;
    u.context = e.input + e.cacheRead + e.cacheWrite;
    if (e.model) u.model = e.model;
    u.at = new Date(s.t).toISOString();
  } else if ("u" in s && s.u.sessionUpdate === "usage_update") {
    u ??= fresh();
    if (typeof s.u.used === "number") u.context = s.u.used;
    if (typeof s.u.size === "number") u.window = s.u.size;
    u.at = new Date(s.t).toISOString();
  }
  return u;
}

/** The session's token use: what each turn's result said, summed; the context as the agent last said it (usage_update). */
export function usageOf(record: Seen[]): SessionUsage | null {
  let u: SessionUsage | null = null;
  for (const s of record) u = addUsage(u, s);
  return u;
}

/**
 * The end of the record, for where it stopped (lastOf): the last `bytes` of it, from the first message in them (a turn
 * whole). whole: it is all of the record.
 */
export function readTail(file: string, bytes = 256 * 1024): { seen: Seen[]; whole: boolean } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return { seen: [], whole: true };
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8").split("\n");
    if (from > 0) lines.shift(); // a line cut where the tail begins
    const seen: Seen[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        seen.push(JSON.parse(line));
      } catch {}
    }
    const first = from > 0 ? seen.findIndex((s) => "user" in s) : 0;
    return { seen: first > 0 ? seen.slice(first) : first < 0 ? [] : seen, whole: from === 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * The session as a timeline (lib/trajectory.ts), at the times the runner saw things: a turn from its message to the
 * prompt's end (its tokens as the result said them), each run of the agent's text or thinking from the update before
 * it to its last chunk, each call from when it was announced to when it finished. ACP says nothing of single model
 * requests: an "assistant" record is a stretch of the agent's text, not a request.
 */
export function trajectoryOf(record: Seen[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  const said = new Map<string, Partial<TrajectoryRecord>>();
  for (const turn of turnsIn(record)) {
    const turnId = turn.user.id;
    records.push({ id: turnId, turnId, kind: "user", start: turn.user.t, input: turn.user.text });
    let last = turn.user.t;
    let block: TrajectoryRecord | null = null;
    const tools = new Map<string, TrajectoryRecord>();
    for (const { t, u } of turn.seen) {
      const chunk = u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk";
      if (chunk) {
        const text = String(u.content?.text ?? "");
        if (!block) records.push((block = { id: `${turnId}:a${records.length}`, turnId, kind: "assistant", start: last, end: t }));
        block.end = t;
        if (u.sessionUpdate === "agent_message_chunk") block.output = `${block.output ?? ""}${text}`;
        else block.thinking = `${block.thinking ?? ""}${text}`;
      } else block = null;
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const id = String(u.toolCallId ?? "");
        let r = tools.get(id);
        if (!r) {
          records.push((r = { id, turnId, kind: "tool", start: t, name: toolNameOf(u), input: u.rawInput ?? {} }));
          tools.set(id, r);
        }
        if (u.rawInput && Object.keys(u.rawInput).length) r.input = u.rawInput;
        if (u.status === "completed" || u.status === "failed") {
          r.end ??= t;
          r.output = outputOf(u);
          if (u.status === "failed") r.error = true;
        }
      }
      last = t;
    }
    if (turn.end) said.set(turnId, { end: turn.end.t, status: statusOf(turn.end.stopReason), ...(turn.end.usage ? { usage: turn.end.usage, ...(turn.end.usage.model ? { model: turn.end.usage.model } : {}) } : {}) });
  }
  return [...turnsOf(records, said), ...records].sort(byTime);
}
