// An agent's `renew`: when its session is old enough that its next turn starts a fresh one (runners/src/lib/renew.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { dueForRenew, renewBoundary } from "../../packages/runners/src/lib/renew.ts";

const at = (s: string) => new Date(s); // local time
const ms = (s: string) => at(s).getTime();

test("day: the day turns at 4:00 local, so a late evening stays one session", () => {
  assert.equal(renewBoundary("day", at("2026-11-05T14:00:00")), ms("2026-11-05T04:00:00"));
  assert.equal(renewBoundary("day", at("2026-11-05T02:30:00")), ms("2026-11-04T04:00:00"));
  assert.equal(dueForRenew("day", ms("2026-11-04T23:50:00"), at("2026-11-05T01:10:00")), false);
  assert.equal(dueForRenew("day", ms("2026-11-04T23:50:00"), at("2026-11-05T09:00:00")), true);
  assert.equal(dueForRenew("day", ms("2026-11-05T08:00:00"), at("2026-11-05T22:00:00")), false);
});

test("week: Monday 4:00; a number: that many hours", () => {
  // 2026-11-05 is a Thursday; that week's Monday is 11-02
  assert.equal(renewBoundary("week", at("2026-11-05T14:00:00")), ms("2026-11-02T04:00:00"));
  assert.equal(renewBoundary("week", at("2026-11-02T03:00:00")), ms("2026-10-26T04:00:00"));
  assert.equal(dueForRenew(12, ms("2026-11-05T01:00:00"), at("2026-11-05T14:00:00")), true);
  assert.equal(dueForRenew(12, ms("2026-11-05T03:00:00"), at("2026-11-05T14:00:00")), false);
});

test("no renew, an unknown begin, or a nonsense number: never", () => {
  assert.equal(dueForRenew(undefined, 0), false);
  assert.equal(dueForRenew("day", null), false);
  assert.equal(dueForRenew(0, 0), false);
  assert.equal(dueForRenew(-3, 0), false);
});
