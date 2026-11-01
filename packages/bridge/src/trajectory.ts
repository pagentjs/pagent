// An agent's session as a timeline, for pages (SPEC 13.17): useTrajectory(agent) is its records (contract.ts,
// TrajectoryRecord), kept current from the agent's own events (no polling): read again as a turn starts and ends, as it
// steps (at most once a second), when a question is asked or answered, and when its conversation grew outside the app.
// After the first read only what changed comes (the host's `at`): a record that did not change keeps its identity.
import { useCallback, useEffect, useState } from "react";
import type { TrajectoryPage, TrajectoryRecord } from "./contract.ts";
import { useHost, useResolvedAgent, type AgentHandle } from "./index.tsx";

export type Trajectory = {
  /** In time order. Long inputs and outputs are cut (truncated: true): record(id) has one whole. */
  records: TrajectoryRecord[];
  /** The first read has landed. */
  loaded: boolean;
  /** Why the last read failed (the records stay as they were). */
  error: string | null;
  /** One record whole (null: no such record any more). */
  record: (id: string) => Promise<TrajectoryRecord | null>;
};

const STEP = 1000; // while it works, at most one read a second

const rank = (r: TrajectoryRecord) => (r.kind === "turn" ? 0 : r.kind === "user" ? 1 : r.parent ? 3 : 2);

/**
 * The records after a page of what changed: each changed one where it was (a new one at the end), the removed ones
 * left out, then in time order as the engine orders them (a stable sort: the rest keep the order they had). Unchanged
 * records are the same objects; nothing changed: the same list.
 */
export function mergeTrajectory(had: TrajectoryRecord[], page: TrajectoryPage): TrajectoryRecord[] {
  if (page.whole !== false) return page.records;
  const removed = new Set(page.removed ?? []);
  if (!page.records.length && !had.some((r) => removed.has(r.id))) return had;
  const changed = new Map(page.records.map((r) => [r.id, r]));
  const out: TrajectoryRecord[] = [];
  for (const r of had) {
    if (removed.has(r.id)) continue;
    const c = changed.get(r.id);
    out.push(c ?? r);
    changed.delete(r.id);
  }
  out.push(...changed.values());
  return out.sort((a, b) => a.start - b.start || rank(a) - rank(b));
}

export function useTrajectory(agent?: AgentHandle | string): Trajectory {
  const target = useResolvedAgent(agent);
  const host = useHost();
  const [state, setState] = useState<{ key: string; records: TrajectoryRecord[]; loaded: boolean; error: string | null }>({ key: "", records: [], loaded: false, error: null });
  const ref = { node: target.node, agent: target.agent };
  const key = `${target.node}#${target.agent}`;

  useEffect(() => {
    // This effect's own reading state: another agent's (an effect before this one, still reading) never blocks it.
    const r: { busy: boolean; again: boolean; timer?: ReturnType<typeof setTimeout>; last: number; at?: string; records: TrajectoryRecord[] } = { busy: false, again: false, last: 0, records: [] };
    let alive = true;
    const read = () => {
      if (r.busy) return void (r.again = true);
      r.busy = true;
      r.last = Date.now();
      host
        .trajectory(ref, r.at ? { after: r.at } : undefined)
        .then(
          (page) => {
            if (!alive) return;
            const records = mergeTrajectory(r.records, page);
            r.at = page.at;
            const same = records === r.records;
            r.records = records;
            setState((s) => (same && s.key === key && s.loaded && !s.error ? s : { key, records, loaded: true, error: null }));
          },
          (e: Error) => alive && setState((s) => ({ key, records: s.key === key ? s.records : [], loaded: true, error: e.message })),
        )
        .finally(() => {
          r.busy = false;
          if (r.again && alive) (r.again = false), read();
        });
    };
    /** Soon (a turn started or ended), or no more than once a second (a step). */
    const soon = (wait: number) => {
      if (r.timer) return;
      r.timer = setTimeout(() => ((r.timer = undefined), read()), wait);
    };
    setState({ key, records: [], loaded: false, error: null });
    read();
    const off = host.onAgent(ref, (e) => {
      if (e.type === "activity") soon(Math.max(0, STEP - (Date.now() - r.last)));
      else soon(100);
    });
    return () => {
      alive = false;
      clearTimeout(r.timer);
      r.timer = undefined;
      off();
    };
  }, [host, key]);

  const record = useCallback((id: string) => host.trajectoryRecord(ref, id), [host, key]);
  // Another agent's records (its effect not run yet) are never shown as this one's.
  const shown = state.key === key ? state : { records: [], loaded: false, error: null };
  return { records: shown.records, loaded: shown.loaded, error: shown.error, record };
}
