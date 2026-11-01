// An agent's session as a timeline (SPEC 13.17): what its runner reads from the harness's own record ("trajectory" op,
// runners/src/lib/trajectory.ts), kept while that record is unchanged, and what only the app adds: each turn under the
// app's id for it (ids.ts: the id a turn trigger and the console have), who each message came from and whether it came
// through the app at all, and the waits on the person (waits.ts). Lists are cut (long inputs and outputs); one record
// whole, by its id. A view that has a list asks for what changed since (trajectoryPage's `after`): a long session's
// records are not sent again whole at every step of a turn.
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { UIMessage } from "ai";
import { parseLine, type Caller } from "../caller.ts";
import { keyOf, type AgentRef } from "../refs.ts";
import { history, runnerOp } from "./history.ts";
import { appIdMap } from "./ids.ts";
import { waitsOf } from "./waits.ts";
import type { Ctx } from "./types.ts";

/** A record as the runner gives it (its type is the bridge's TrajectoryRecord), with what the engine adds. */
export type TrajectoryRecord = {
  id: string;
  turnId: string | null;
  kind: string;
  start: number;
  end?: number;
  name?: string;
  input?: unknown;
  output?: unknown;
  thinking?: string;
  via?: "app" | "terminal" | "harness";
  from?: Caller;
  wait?: string;
  truncated?: boolean;
  [more: string]: unknown;
};

/** How many agents' trajectories are kept in memory (the ones looked at last). */
const AGENTS = 16;

/** A map that keeps the `max` keys used last. */
class Recent<V> extends Map<string, V> {
  private max: number;
  constructor(max: number) {
    super();
    this.max = max;
  }
  override get(key: string): V | undefined {
    const v = super.get(key);
    if (v !== undefined) (super.delete(key), super.set(key, v));
    return v;
  }
  override set(key: string, v: V): this {
    super.delete(key);
    super.set(key, v);
    for (const k of this.keys()) {
      if (this.size <= this.max) break;
      this.delete(k);
    }
    return this;
  }
}

// What the runner read, its stamp and its records. The stamp is taken before the runner reads (what the harness writes
// while it reads changes it, and is read next time); a record read with no stamp before it (the first) is not kept as
// unchanged: only its files are, for the next read's stamp.
const kept = new Recent<{ files: string[]; stamp: string; records: TrajectoryRecord[] }>(AGENTS);
const stampOf = (file: string) => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
};
const stampsOf = (files: string[]) => files.map(stampOf).join("|");

const reading = new Map<string, Promise<TrajectoryRecord[]>>();

/**
 * The runner's records, read again only when what it read changed (a long session's transcript is megabytes), and
 * once for everyone who asks while it is being read (each step of a turn has every open view ask).
 */
function fromRunner(ctx: Ctx, ref: AgentRef): Promise<TrajectoryRecord[]> {
  const key = keyOf(ref);
  const k = kept.get(key);
  if (k && k.stamp && stampsOf(k.files) === k.stamp) return Promise.resolve(k.records);
  if (!reading.has(key)) {
    reading.set(key, (async () => {
      const before = k ? stampsOf(k.files) : "";
      const out = await runnerOp(ctx, ref, "trajectory", "trajectory").catch(() => null);
      const records: TrajectoryRecord[] = Array.isArray(out?.records) ? out.records : [];
      if (typeof out?.file === "string") {
        const files: string[] = [out.file, ...(Array.isArray(out.watch) ? out.watch.filter((w: unknown) => typeof w === "string") : [])];
        const same = !!k && files.join("\n") === k.files.join("\n");
        kept.set(key, { files, stamp: same ? before : "", records });
      } else kept.delete(key);
      return records;
    })().finally(() => reading.delete(key)));
  }
  return reading.get(key)!;
}

/**
 * The whole trajectory: the runner's records with each turn under the app's id for it; a message's sender (a page, an
 * agent, a trigger: its "(from …)" line, then its words) and whether it came through the app ("app": a run of the
 * app's; "terminal": typed into the harness's own terminal, outside it; "harness": the harness's own, said by the
 * runner); and the waits on the person, in the turn they were asked in (one asked outside a turn: the turn it falls
 * in, else the one before it). In time order; every id once.
 */
export function trajectory(ctx: Ctx, ref: AgentRef): Promise<TrajectoryRecord[]> {
  return made(ctx, ref).then((m) => m.records);
}

/** One reading of the trajectory: its records, as lists have them, and when each last changed (Versions). */
type Made = { records: TrajectoryRecord[]; listed: TrajectoryRecord[]; changed: number[]; removed: [string, number][]; at: number };
const making = new Map<string, Promise<Made>>();

/** The trajectory, made once for everyone who asks while it is being made (the history it reads too). */
function made(ctx: Ctx, ref: AgentRef): Promise<Made> {
  const key = keyOf(ref);
  if (!making.has(key)) making.set(key, make(ctx, ref).finally(() => making.delete(key)));
  return making.get(key)!;
}

async function make(ctx: Ctx, ref: AgentRef): Promise<Made> {
  const runner = await fromRunner(ctx, ref);
  await history(ctx, ref).catch(() => [] as UIMessage[]); // settles the ids of the runs found by their words (ids.ts)
  const ids = appIdMap(ctx, ref);
  const app = new Set(Object.keys(ids));
  const records: TrajectoryRecord[] = runner.map((r) => {
    const turnId = r.turnId && ids[r.turnId] ? ids[r.turnId] : r.turnId;
    const out: TrajectoryRecord = { ...r, turnId, ...(r.kind === "turn" ? { id: `turn:${turnId}` } : {}) };
    if (r.kind === "user" || r.kind === "turn") {
      const line = typeof r.input === "string" ? parseLine(r.input) : null;
      if (line) Object.assign(out, { from: line.caller, input: line.message, ...(r.kind === "turn" ? { name: line.message } : {}) });
      out.via ??= r.turnId && app.has(r.turnId) ? "app" : "terminal";
    }
    return out;
  });

  const turns = records.filter((r) => r.kind === "turn").sort((a, b) => a.start - b.start);
  const turnAt = (t: number) => [...turns].reverse().find((r) => r.start <= t)?.turnId ?? null;
  for (const w of waitsOf(ctx, ref)) {
    records.push({
      id: `wait:${w.id}`,
      turnId: w.turnId ?? turnAt(w.start),
      kind: "wait",
      wait: w.kind,
      start: w.start,
      ...(w.end !== undefined ? { end: w.end } : {}),
      name: w.question,
      ...(w.detail ? { input: w.detail } : {}),
      ...(w.answer !== undefined ? { output: w.answer } : {}),
      ...(w.gone ? { gone: true } : {}),
    });
  }
  records.sort((a, b) => a.start - b.start || rank(a) - rank(b));
  // Every id once (a view keeps records by id): a second one with the same id is told apart.
  const seen = new Map<string, number>();
  for (const r of records) {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    if (n > 1) r.id = `${r.id}~${n}`;
  }
  const listed = records.map(listedOf);
  return { records, listed, ...versioned(keyOf(ref), listed) };
}
const rank = (r: TrajectoryRecord) => (r.kind === "turn" ? 0 : r.kind === "user" ? 1 : r.parent ? 3 : 2);

// ---------------------------------------------------------------- what changed since

// Each listed record's version: the clock when it last changed (its listed form's hash), and when ids went away; a
// view says the clock it has (`after`), and gets only what changed since. The clock is this server's (BOOT): a view
// that has another's gets everything.
const BOOT = randomBytes(4).toString("hex");
let clock = 0;
const GONE = 2000; // ids gone away remembered per agent; a view older than the ones forgotten gets everything
type Versions = { sigs: Map<string, { sig: string; v: number }>; gone: Map<string, number>; floor: number };
const versions = new Recent<Versions>(AGENTS);

function versioned(key: string, listed: TrajectoryRecord[]): Pick<Made, "changed" | "removed" | "at"> {
  let ver = versions.get(key);
  if (!ver) versions.set(key, (ver = { sigs: new Map(), gone: new Map(), floor: clock }));
  const now = new Set<string>();
  const changed = listed.map((r) => {
    now.add(r.id);
    const sig = createHash("sha1").update(JSON.stringify(r)).digest("base64");
    const was = ver.sigs.get(r.id);
    if (was?.sig === sig) return was.v;
    const v = ++clock;
    ver.sigs.set(r.id, { sig, v });
    ver.gone.delete(r.id);
    return v;
  });
  for (const id of ver.sigs.keys()) {
    if (now.has(id)) continue;
    ver.sigs.delete(id);
    ver.gone.set(id, ++clock);
  }
  for (const [id, v] of ver.gone) {
    if (ver.gone.size <= GONE) break;
    ver.gone.delete(id);
    ver.floor = v;
  }
  return { changed, removed: [...ver.gone], at: clock };
}

/**
 * A view's page of the trajectory: every record as lists have it (whole: true), or, given the `at` of the page it has
 * (after), only the records that changed since and the ids that went away. at: what to say next time.
 */
export async function trajectoryPage(ctx: Ctx, ref: AgentRef, after?: string): Promise<{ records: TrajectoryRecord[]; removed?: string[]; at: string; whole: boolean }> {
  const m = await made(ctx, ref);
  const at = `${BOOT}.${m.at}`;
  const [boot, n] = (after ?? "").split(".");
  const since = Number(n);
  const ver = versions.get(keyOf(ref));
  if (boot !== BOOT || !Number.isInteger(since) || since > m.at || !ver || since < ver.floor) return { records: m.listed, at, whole: true };
  return { records: m.listed.filter((_, i) => m.changed[i] > since), removed: m.removed.filter(([, v]) => v > since && v <= m.at).map(([id]) => id), at, whole: false };
}

// ---------------------------------------------------------------- cut for lists

const CUT = 1200; // characters of a string kept in a list
const DEEP = 4; // levels of a value looked into; below that, a value is kept whole only when it is short
const clip = (v: unknown, depth = 0): { value: unknown; cut: boolean } => {
  if (typeof v === "string") return v.length > CUT ? { value: v.slice(0, CUT) + "…", cut: true } : { value: v, cut: false };
  if (!v || typeof v !== "object") return { value: v, cut: false };
  if (depth > DEEP) {
    const s = JSON.stringify(v) ?? "";
    return s.length > CUT ? { value: s.slice(0, CUT) + "…", cut: true } : { value: v, cut: false };
  }
  let cut = false;
  const one = (x: unknown) => {
    const c = clip(x, depth + 1);
    cut ||= c.cut;
    return c.value;
  };
  if (Array.isArray(v)) {
    const value = v.slice(0, 50).map(one);
    return { value, cut: cut || v.length > 50 };
  }
  return { value: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)])), cut };
};

/** A record as a list has it: its long input, output and thinking cut (truncated: the whole one is a fetch by its id). */
function listedOf(r: TrajectoryRecord): TrajectoryRecord {
  const input = clip(r.input);
  const output = clip(r.output);
  const thinking = clip(r.thinking);
  if (!input.cut && !output.cut && !thinking.cut) return r;
  return { ...r, input: input.value, output: output.value, ...(r.thinking !== undefined ? { thinking: thinking.value as string } : {}), truncated: true };
}
export const listed = listedOf;

/** One record whole (null: not there, or no longer). */
export async function trajectoryRecord(ctx: Ctx, ref: AgentRef, id: string): Promise<TrajectoryRecord | null> {
  return (await trajectory(ctx, ref)).find((r) => r.id === id) ?? null;
}
