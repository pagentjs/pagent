// A session as a timeline (SPEC 13.17), as the runners read it from the harness's own record: Claude Code's transcript
// and its sub-agents' (lib/claude-trajectory.ts), a Codex thread's rollout and its sub-agents' (lib/codex-trajectory.ts).
// The fixtures are real: Claude Code 2.1.302 and codex-cli 0.163.0, each run against a stand-in for the model API
// (scripted replies and token counts, no model), in an isolated HOME / CLAUDE_CONFIG_DIR / CODEX_HOME; paths and names
// made neutral, the bulky request-shape lines left out. One thing in them is written by hand: the compaction in the
// Codex rollout's last turn (its compacted line, context_compacted and ContextCompaction item), shaped as Codex writes
// them, since an auto compaction could not be brought about without a model.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { readMetas } from "../../packages/runners/src/lib/claude-subagents.ts";
import { claudeTrajectory } from "../../packages/runners/src/lib/claude-trajectory.ts";
import { codexTrajectory } from "../../packages/runners/src/lib/codex-trajectory.ts";
import type { TrajectoryRecord } from "../../packages/runners/src/lib/trajectory.ts";
import { listed } from "../../packages/core/src/agents/trajectory.ts";
import { mergeTrajectory } from "../../packages/bridge/src/trajectory.ts";
import type { TrajectoryRecord as BridgeRecord } from "../../packages/bridge/src/contract.ts";

const fixtures = fileURLToPath(new URL("../fixtures/trajectory", import.meta.url));
const lines = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const of = (rs: TrajectoryRecord[], kind: string) => rs.filter((r) => r.kind === kind);
const inside = (r: TrajectoryRecord, t: TrajectoryRecord) => r.start >= t.start && (r.end ?? r.start) <= (t.end ?? Infinity);

describe("Claude Code: a transcript and its sub-agents' as a trajectory", () => {
  const dir = join(fixtures, "claude/-Users-sam-code-lisbon");
  const file = join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
  const text = readFileSync(file, "utf8");
  const raw = lines(text);
  const metas = readMetas(join(file.replace(/\.jsonl$/, ""), "subagents"));
  const rs = claudeTrajectory(text, (id) => {
    const m = metas.get(id);
    return m ? { meta: m.meta, text: readFileSync(m.file, "utf8") } : null;
  });
  const turns = of(rs, "turn");
  const named = (start: string) => turns.find((t) => String(t.name).startsWith(start))!;

  test("a turn for each message, under the id the history shows it (its entry's uuid), in order", () => {
    assert.deepEqual(turns.map((t) => t.name), [
      "SCENARIO:tools please write the notes",
      "SCENARIO:heavy the truncate tests fail, fix it",
      "SCENARIO:agent where is the config read?",
      "SCENARIO:bg look for TODOs in the background",
      'Agent "Scan for TODOs" finished',
      "SCENARIO:fail show nope.txt",
      "/compact",
      "thanks, that is all",
    ]);
    const typed = raw.filter((e) => e.type === "user" && typeof e.message?.content === "string" && !e.isMeta && !e.isCompactSummary && !/^<local-command/.test(e.message.content));
    assert.deepEqual(turns.map((t) => t.turnId), typed.map((e) => e.uuid));
    for (const t of turns) assert.equal(t.id, `turn:${t.turnId}`);
    for (const r of rs) assert.ok(turns.some((t) => t.turnId === r.turnId), `${r.kind} ${r.id} is in a turn`);
    assert.deepEqual(new Set(rs.map((r) => r.id)).size, rs.length, "ids are unique");
  });

  test("a request runs from its api-request line to its last block, with the final usage of its message", () => {
    const replies = of(rs, "assistant").filter((r) => !r.parent);
    const requests = new Map(raw.filter((e) => e.type === "api-request").map((e) => [e.id, Date.parse(e.timestamp)]));
    for (const r of replies) {
      const blocks = raw.filter((e) => e.type === "assistant" && `reply:${e.message.id}` === r.id);
      assert.equal(r.start, requests.get(blocks[0].requestRef), r.id);
      assert.equal(r.end, Math.max(...blocks.map((b) => Date.parse(b.timestamp))));
      assert.deepEqual(r.usage, { input: blocks.at(-1).message.usage.input_tokens, cacheRead: blocks.at(-1).message.usage.cache_read_input_tokens, cacheWrite: blocks.at(-1).message.usage.cache_creation_input_tokens, output: blocks.at(-1).message.usage.output_tokens });
      assert.equal(r.model, "claude-sonnet-4-5");
    }
    const first = replies[0];
    assert.equal(first.output, "Let me look around first.");
    const thought = replies.find((r) => r.thinking)!;
    assert.match(thought.thinking!, /The tests fail on truncate/);
  });

  test("a tool-heavy turn: each call from its tool_use to its result, side by side when they ran so; a failed one is an error", () => {
    const heavy = named("SCENARIO:heavy");
    const calls = of(rs, "tool").filter((r) => r.turnId === heavy.turnId);
    assert.deepEqual(calls.map((c) => c.name), ["Read", "Read", "Grep", "Bash", "Write", "Bash", "Bash", "Edit", "Bash"]);
    for (const c of calls) assert.ok(c.end! >= c.start && inside(c, heavy), `${c.name} within its turn`);
    const [quick, slow] = calls.filter((c) => c.name === "Bash").slice(1, 3);
    assert.ok(slow.start < quick.end! && slow.end! - slow.start > 2900, "two calls of one request overlap; the slow one took its 3 s");
    assert.deepEqual(calls[0].input, { file_path: "main.js" });
    assert.match(String(calls[0].output), /require\("\.\/config\.json"\)/);
    const failed = of(rs, "tool").find((r) => r.turnId === named("SCENARIO:fail").turnId)!;
    assert.equal(failed.error, true);
    assert.match(String(failed.output), /No such file/);
  });

  test("a sub-agent: its call is the record, its own requests and calls under it, its tokens summed, its answer as output", () => {
    const turn = named("SCENARIO:agent");
    const agent = of(rs, "subagent").find((r) => r.turnId === turn.turnId)!;
    assert.equal(agent.name, "general-purpose");
    assert.equal(agent.background, undefined);
    assert.equal(agent.output, "config.json is read in main.js.");
    const steps = rs.filter((r) => r.parent === agent.id);
    assert.deepEqual(steps.map((r) => `${r.kind} ${r.name}`), ["assistant claude-sonnet-4-5", "tool Bash", "assistant claude-sonnet-4-5", "tool Grep", "assistant claude-sonnet-4-5"]);
    for (const s of steps) assert.ok(inside(s, agent), `${s.kind} within the sub-agent`);
    const sum = of(steps, "assistant").reduce((n, r) => n + r.usage!.output, 0);
    assert.equal(agent.usage!.output, sum);
    assert.equal(turn.usage!.output, of(rs, "assistant").filter((r) => r.turnId === turn.turnId).reduce((n, r) => n + r.usage!.output, 0), "a turn's tokens are its requests', its sub-agent's too");
  });

  test("a sub-agent in the background ends with its notification, a turn of the harness's own; its turn does not wait for it", () => {
    const turn = named("SCENARIO:bg");
    const agent = of(rs, "subagent").find((r) => r.turnId === turn.turnId)!;
    const notice = named('Agent "Scan for TODOs"');
    assert.equal(agent.background, true);
    assert.equal(agent.name, "Explore");
    assert.equal(agent.end, notice.start);
    assert.ok(turn.end! < agent.end!, "the turn ended before its sub-agent did");
    assert.equal(notice.via, "harness");
    assert.equal(of(rs, "user").find((u) => u.turnId === notice.turnId)!.name, "background");
  });

  test("a compaction, in the /compact turn it was made in: its tokens before and after, its summary", () => {
    const [c] = of(rs, "compaction");
    const boundary = raw.find((e) => e.subtype === "compact_boundary");
    assert.equal(c.turnId, named("/compact").turnId);
    assert.equal(c.name, "manual");
    assert.equal(c.end, Date.parse(boundary.timestamp));
    assert.equal(c.start, c.end! - boundary.compactMetadata.durationMs);
    assert.deepEqual({ ...(c.input as object) }, { tokensBefore: boundary.compactMetadata.preTokens });
    assert.match((c.output as { summary: string }).summary, /^This session is being continued/);
    assert.equal((c.output as { tokensAfter: number }).tokensAfter, boundary.compactMetadata.postTokens);
  });

  test("what each turn cost, as Claude Code reckons it: the growth of its cost-state (the session's so far, kept across --continue)", () => {
    const states = raw.filter((e) => e.type === "cost-state");
    const total = states.at(-1).totalCostUSD;
    const said = turns.reduce((n, t) => n + (t.costUSD ?? 0), 0);
    assert.ok(Math.abs(total - said) < 1e-9, `${total} = ${said}`);
    assert.ok(Math.abs(named("SCENARIO:tools").costUSD! - states[0].totalCostUSD) < 1e-9);
  });

  test("a cost-state of another accounting (startTime) starts over; an interrupted turn says so", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-18T05:00:00Z") + s * 1000).toISOString();
    const t = [
      { type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: "one" } },
      { type: "assistant", uuid: "a1", timestamp: at(2), message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 2 } } },
      { type: "system", subtype: "turn_duration", timestamp: at(3) },
      { type: "cost-state", totalCostUSD: 0.5, startTime: 1 },
      { type: "user", uuid: "u2", timestamp: at(10), message: { role: "user", content: "two" } },
      { type: "assistant", uuid: "a2", timestamp: at(11), message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 2 } } },
      { type: "user", uuid: "x", timestamp: at(12), message: { role: "user", content: "[Request interrupted by user]" } },
      { type: "cost-state", totalCostUSD: 0.8, startTime: 1 },
      { type: "user", uuid: "u3", timestamp: at(20), message: { role: "user", content: "three" } },
      { type: "cost-state", totalCostUSD: 0.1, startTime: 2 },
    ].map((o) => JSON.stringify(o)).join("\n");
    const out = of(claudeTrajectory(t), "turn");
    assert.deepEqual(out.map((r) => [r.turnId, +r.costUSD!.toFixed(3), r.end, r.status]), [
      ["u1", 0.5, Date.parse(at(3)), undefined],
      ["u2", 0.3, Date.parse(at(11)), "interrupted"],
      ["u3", 0.1, Date.parse(at(20)), undefined],
    ]);
    // No api-request lines (an older Claude Code): a request starts when the line before it was written.
    assert.equal(claudeTrajectory(t).find((r) => r.id === "reply:m1")!.start, Date.parse(at(0)));
  });
});

describe("Codex: a thread's rollout and its sub-agents' as a trajectory", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(join(fixtures, "codex/sessions"));
  const main = files.find((f) => lines(readFileSync(f, "utf8"))[0].payload.parent_thread_id === undefined)!;
  const text = readFileSync(main, "utf8");
  const raw = lines(text);
  const read: string[] = [];
  const rs = codexTrajectory(text, (thread) => {
    const f = files.find((f) => f.endsWith(`-${thread}.jsonl`));
    if (f) read.push(thread);
    return f ? readFileSync(f, "utf8") : null;
  });
  const turns = of(rs, "turn");
  const items = raw.filter((e) => e.payload?.type === "item_completed").map((e) => ({ ...e.payload.item, startedAt: e.payload.started_at_ms, completedAt: e.payload.completed_at_ms, at: Date.parse(e.timestamp) }));

  test("a turn for each message, under its item's id (thread/turns/list has the same), with Codex's own end, status and time to first token", () => {
    assert.deepEqual(turns.map((t) => t.name), ["SCENARIO:tools write the notes", "SCENARIO:fail show nope.txt", "SCENARIO:agent where is the config read?", "thanks, that is all"]);
    assert.deepEqual(turns.map((t) => t.turnId), items.filter((i) => i.type === "UserMessage").map((i) => i.id));
    const done = raw.filter((e) => e.payload?.type === "task_complete");
    assert.deepEqual(turns.map((t) => [t.end, t.status, t.ttftMs]), done.map((e) => [Date.parse(e.timestamp), "completed", e.payload.time_to_first_token_ms]));
    assert.deepEqual(new Set(rs.map((r) => r.id)).size, rs.length, "ids are unique");
  });

  test("a request runs from what was last sent to it to its token usage record; input without the cached part", () => {
    const records = raw.filter((e) => e.type === "token_usage_record" && e.payload.thread_id === raw[0].payload.id);
    const replies = of(rs, "assistant").filter((r) => !r.parent);
    assert.deepEqual(replies.map((r) => r.id), records.map((e) => e.payload.response_id));
    for (const [i, r] of replies.entries()) {
      const u = records[i].payload.usage;
      assert.equal(r.end, Date.parse(records[i].timestamp));
      assert.ok(r.start <= r.end!);
      assert.deepEqual(r.usage, { input: u.input_tokens - u.cached_input_tokens, cacheRead: u.cached_input_tokens, cacheWrite: 0, output: u.output_tokens, reasoning: u.reasoning_output_tokens });
      assert.equal(r.model, "gpt-5.1-codex");
    }
    assert.equal(replies[0].output, "Looking at the files.");
    assert.equal(replies[0].start, items.find((i) => i.type === "UserMessage")!.completedAt);
  });

  test("calls: from the model's call to the item's end, under the item's id; a failed command is an error", () => {
    const calls = of(rs, "tool").filter((r) => !r.parent);
    assert.deepEqual(calls.map((c) => c.name), ["shell", "shell", "apply_patch", "shell", "wait"]);
    for (const c of calls) {
      const item = items.find((i) => i.id === c.id)!;
      const asked = raw.find((e) => e.type === "response_item" && e.payload.call_id === c.id)!;
      assert.equal(c.start, Date.parse(asked.timestamp), c.id);
      assert.equal(c.end, item.completedAt);
    }
    assert.deepEqual(calls[0].input, { command: "ls -la" });
    assert.equal(calls[3].error, true);
    assert.match(String(calls[3].output), /No such file/);
    assert.deepEqual((calls[2].input as { changes: { kind: string }[] }).changes.map((c) => c.kind), ["add"]);
  });

  test("a sub-agent: its own thread's rollout under its spawn, until its turn completed; its tokens summed", () => {
    const [agent] = of(rs, "subagent");
    const spawn = items.find((i) => i.type === "CollabAgentToolCall" && i.tool === "spawn_agent")!;
    assert.equal(agent.id, spawn.id);
    assert.equal(agent.name, spawn.receiver_agents[0].agent_nickname);
    assert.deepEqual(read, [spawn.receiver_thread_ids[0]]);
    const child = lines(readFileSync(files.find((f) => f.endsWith(`-${spawn.receiver_thread_ids[0]}.jsonl`))!, "utf8"));
    assert.equal(agent.end, Date.parse(child.find((e) => e.payload?.type === "task_complete").timestamp));
    const steps = rs.filter((r) => r.parent === agent.id);
    assert.deepEqual(steps.map((r) => `${r.kind} ${r.name}`), ["assistant gpt-5.1-codex", "tool shell", "assistant gpt-5.1-codex"]);
    assert.equal(agent.usage!.output, steps.filter((s) => s.kind === "assistant").reduce((n, s) => n + s.usage!.output, 0));
    assert.equal(agent.output, "config.json is read in main.js.");
    assert.ok(steps.every((s) => s.turnId === agent.turnId));
  });

  test("a compaction: the compacted line's summary and the ContextCompaction item's time, as one record", () => {
    const [c] = of(rs, "compaction");
    const item = items.find((i) => i.type === "ContextCompaction")!;
    assert.equal(c.id, item.id);
    assert.deepEqual([c.start, c.end], [item.startedAt, item.completedAt]);
    assert.match((c.output as { summary: string }).summary, /^Summary: sam asked/);
    assert.equal(c.turnId, turns.at(-1)!.turnId);
  });

  test("an older rollout, without item_completed lines: its messages, calls and requests, by their lines", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-18T05:00:00Z") + s * 1000).toISOString();
    const old = [
      { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: "/Users/sam/code/lisbon" } },
      { timestamp: at(0), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } },
      { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list the files" }] } },
      { timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "c1" } },
      { timestamp: at(2), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 } } } },
      { timestamp: at(3), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "README.md" } },
      { timestamp: at(4), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "One file." }] } },
      { timestamp: at(4), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 3 } } } },
    ].map((o) => JSON.stringify(o)).join("\n");
    const out = codexTrajectory(old);
    assert.deepEqual(out.map((r) => `${r.kind} ${r.name ?? ""}`.trim()), ["turn list the files", "user", "assistant", "tool shell", "assistant"]);
    assert.deepEqual(of(out, "tool")[0].input, { command: ["ls"] });
    assert.deepEqual([of(out, "tool")[0].start, of(out, "tool")[0].end], [Date.parse(at(2)), Date.parse(at(3))]);
    assert.deepEqual(of(out, "assistant").map((r) => [r.start, r.end, r.usage!.input, r.output]), [
      [Date.parse(at(1)), Date.parse(at(2)), 60, undefined],
      [Date.parse(at(3)), Date.parse(at(4)), 20, "One file."],
    ]);
  });
});

test("a list's records are cut, and say so; a short one is the same object", () => {
  const long = { id: "t", turnId: "u", kind: "tool", start: 0, input: { content: "x".repeat(5000), n: 3 }, output: "y".repeat(5000) };
  const cut = listed(long);
  assert.equal(cut.truncated, true);
  assert.equal((cut.input as { content: string }).content.length, 1201);
  assert.equal((cut.input as { n: number }).n, 3);
  assert.equal((cut.output as string).length, 1201);
  const short = { id: "s", turnId: "u", kind: "tool", start: 0, input: { command: "ls" }, output: "ok" };
  assert.equal(listed(short), short);
});

test("a value deeper than a list looks is cut too, whole when it is short", () => {
  const deep = (v: unknown, n: number): unknown => (n ? { a: deep(v, n - 1) } : v);
  const cut = listed({ id: "d", turnId: "u", kind: "tool", start: 0, input: deep({ blob: "z".repeat(100_000) }, 8) });
  assert.equal(cut.truncated, true);
  assert.ok(JSON.stringify(cut.input).length < 2000, "not 100 KB in a list");
  const short = { id: "e", turnId: "u", kind: "tool", start: 0, input: deep({ ok: 1 }, 8) };
  assert.equal(listed(short), short);
});

test("a view's records after a page of what changed: unchanged ones are the same objects, in time order", () => {
  const r = (id: string, start: number, more: object = {}) => ({ id, turnId: "t", kind: "tool", start, ...more }) as BridgeRecord;
  const had = [r("turn:t", 0, { kind: "turn" }), r("a", 1), r("b", 2), r("c", 3)];
  assert.equal(mergeTrajectory(had, { records: [], removed: [], at: "x.2", whole: false }), had, "nothing changed: the same list");
  const b2 = r("b", 2, { end: 5 });
  const d = r("d", 4);
  const next = mergeTrajectory(had, { records: [d, b2], removed: ["c"], at: "x.3", whole: false });
  assert.deepEqual(next.map((x) => x.id), ["turn:t", "a", "b", "d"]);
  assert.equal(next[1], had[1], "unchanged: the same object");
  assert.equal(next[2], b2);
  const early = r("z", 0.5);
  assert.deepEqual(mergeTrajectory(next, { records: [early], at: "x.4", whole: false }).map((x) => x.id), ["turn:t", "z", "a", "b", "d"]);
  const whole = [r("q", 9)];
  assert.equal(mergeTrajectory(had, { records: whole, at: "y.1", whole: true }), whole);
  assert.equal(mergeTrajectory(had, { records: whole }), whole, "a host that cannot say what changed: all of it");
});
