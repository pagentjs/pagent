// An agent's `renew` (AgentSpec): when the session it is on has run long enough that its next turn starts a fresh one.
// "day": one that began before today's 4:00 (local; before 4:00 that is yesterday's), "week": before this Monday's 4:00,
// a number: more than that many hours ago. The day turns at 4:00, not midnight, so a late evening stays one session.

export type Renew = "day" | "week" | number;

/** The moment a session must have begun after to be kept (ms since the epoch). */
export function renewBoundary(renew: Renew, now = new Date()): number {
  if (typeof renew === "number") return now.getTime() - renew * 3600e3;
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  if (now.getTime() < d.getTime()) d.setDate(d.getDate() - 1);
  if (renew === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Whether a session that began at `began` (ms) is due for a fresh one. No renew, or a begin not known: never. */
export function dueForRenew(renew: Renew | undefined, began: number | null, now = new Date()): boolean {
  if (renew === undefined || renew === null || began === null || !Number.isFinite(began)) return false;
  if (typeof renew === "number" && !(renew > 0)) return false;
  return began < renewBoundary(renew, now);
}
