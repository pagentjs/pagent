// An agent's session as a timeline (SPEC 13.17), in the shape every runner gives it (bridge/src/contract.ts has the same
// type, TrajectoryRecord): the "trajectory" op reads the harness's own record of the session and says what happened in
// it, when, with what tokens. Only what the record says: nothing is estimated here (a time it does not say is left out).
//   { op: "trajectory", cwd, stateDir, … } → { type: "trajectory", records: TrajectoryRecord[], file, watch }
// Here a record's turnId is the transcript's own id of the message that started its turn (what the history shows that
// message under); the engine puts the app's id for it in its place (core: agents/trajectory.ts), adds what only the app
// knows (who a message came from, whether it came through the app, the waits on the person) and cuts long ones.

export type TrajectoryKind = "turn" | "user" | "assistant" | "tool" | "subagent" | "compaction" | "wait";

/** One request's tokens, as the harness counts them: input not from the cache, cache reads, cache writes, output. */
export type TrajectoryUsage = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning?: number };

export type TrajectoryRecord = {
  /** Unique in the session: the harness's own id for it where it has one (a tool call's, a message's). */
  id: string;
  /** The turn it is part of: the id of the message that started that turn. null: before any. */
  turnId: string | null;
  kind: TrajectoryKind;
  /** When it started and ended, ms since the epoch. No end: still going, or the record never said. */
  start: number;
  end?: number;
  /** turn, user: its message; tool: the tool's name; subagent: its kind; assistant: the model; compaction: auto or manual. */
  name?: string;
  input?: unknown;
  output?: unknown;
  /** assistant: what it thought, as the harness keeps it. */
  thinking?: string;
  error?: boolean;
  /** assistant: its request's; turn and subagent: the sum of their requests'. */
  usage?: TrajectoryUsage;
  model?: string;
  /** The sub-agent record it happened inside. */
  parent?: string;
  /** subagent: it ran in the background (the call returned at once, the turn went on without it). */
  background?: boolean;
  /** user: "harness", the harness's own (a background task's notification); else the engine says (app, terminal). */
  via?: "app" | "terminal" | "harness";
  /** turn: what the harness says it cost, in US dollars (Claude Code's own reckoning). */
  costUSD?: number;
  /** turn: how long the model took to its first token, when the harness says (Codex). */
  ttftMs?: number;
  /** turn: how it ended, when the harness says ("completed", "interrupted", "failed"). */
  status?: string;
};

export const addUsage = (a: TrajectoryUsage | undefined, b: TrajectoryUsage | undefined): TrajectoryUsage | undefined =>
  !b ? a : !a ? { ...b } : { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, ...(a.reasoning || b.reasoning ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : {}) };

export const ms = (t: unknown): number | undefined => {
  const n = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The turn records, from the records of each turn: from its message to the end of the last thing it waited for (or
 * `end`, when the harness says where the turn ended), its requests' tokens summed (a sub-agent's too), its message as
 * its name.
 */
export function turnsOf(records: TrajectoryRecord[], said: Map<string, Partial<TrajectoryRecord>> = new Map()): TrajectoryRecord[] {
  const turns = new Map<string, TrajectoryRecord>();
  for (const r of records) {
    if (!r.turnId) continue;
    let t = turns.get(r.turnId);
    if (!t) turns.set(r.turnId, (t = { id: `turn:${r.turnId}`, turnId: r.turnId, kind: "turn", start: r.start }));
    if (r.kind === "user" && r.id === r.turnId) (t.start = r.start), (t.name = typeof r.input === "string" ? r.input : t.name), (t.input = r.input);
    t.start = Math.min(t.start, r.start);
    // What the turn waited for: its own steps, not what it left running (a sub-agent in the background, its steps).
    const end = r.parent || r.background ? r.start : (r.end ?? r.start);
    if (t.end === undefined || end > t.end) t.end = end;
    if (r.kind === "assistant") t.usage = addUsage(t.usage, r.usage);
  }
  for (const [id, more] of said) {
    const t = turns.get(id);
    if (t) Object.assign(t, Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined)));
  }
  return [...turns.values()];
}

/** In time order (a turn before what is in it, a call before its sub-agent's steps). */
export const byTime = (a: TrajectoryRecord, b: TrajectoryRecord) => a.start - b.start || rank(a) - rank(b);
const rank = (r: TrajectoryRecord) => (r.kind === "turn" ? 0 : r.kind === "user" ? 1 : r.parent ? 3 : 2);
