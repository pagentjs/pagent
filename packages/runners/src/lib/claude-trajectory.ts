// A Claude Code session as a trajectory (lib/trajectory.ts), from its transcript and its sub-agents' (Claude Code
// 2.1.302; older ones write less, and get less).
//
// What the transcript says, line by line (each with its timestamp):
//   user          a message that starts a turn (as the history shows it: the same entry, the same uuid); a tool's
//                 result (tool_result blocks; toolUseResult: what the tool returned, an Agent call's numbers); the
//                 summary after a compaction (isCompactSummary); a background task's <task-notification>
//   attachment    queued_command: a message typed while it worked, taken in between two tool calls
//   api-request   a request sent to the model (id, timestamp): the start of the reply whose lines name it (requestRef)
//   assistant     one line per block of a reply (text, thinking, tool_use), each with the reply's usage so far; the
//                 reply is message.id, its last line's usage is final
//   system        compact_boundary (compactMetadata: trigger, preTokens, postTokens, durationMs); turn_duration (the
//                 TUI's turn ended)
//   cost-state    what the process has spent so far (totalCostUSD, with startTime: one process; a headless turn is a
//                 process of its own, a TUI one process for many turns): the difference is the turn's
// A reply without its api-request line (an older Claude Code) starts when the line before it was written: the last
// thing sent to it. A tool call runs from its tool_use block to its result. A sub-agent (an Agent / Task call) is its
// own transcript (claude-subagents.ts), read into records under its call; in the background, it ends with the
// notification Claude Code wakes the agent with.
import { AGENT_TOOLS, notification, type Meta } from "./claude-subagents.ts";
import { addUsage, byTime, ms, turnsOf, type TrajectoryRecord, type TrajectoryUsage } from "./trajectory.ts";

/** A sub-agent's transcript and meta, by the id of the call that started it. */
export type SubagentSource = (toolUseId: string) => { meta?: Meta; text: string } | null;

const usageOf = (u: any): TrajectoryUsage | undefined =>
  u ? { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens), ...(num(u.output_tokens_details?.thinking_tokens) ? { reasoning: num(u.output_tokens_details.thinking_tokens) } : {}) } : undefined;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const resultText = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("") : JSON.stringify(content ?? "");

/** A long message pasted into the TUI (how the app types into it) is stored wrapped. */
const unpasted = (text: string) => text.replace(/^\s*<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">\s*$/, "$1");

const INTERRUPTED = /^\[Request interrupted by user/;

/** The whole session (or, with `sub`, a sub-agent's transcript: its records under its call, in that call's turn). */
export function claudeTrajectory(text: string, subagents: SubagentSource = () => null, sub?: { parent: string; turnId: string | null; seen: Set<string> }): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  const replies = new Map<string, TrajectoryRecord>(); // message.id → its record
  const tools = new Map<string, TrajectoryRecord>(); // tool_use id → its record
  const requests = new Map<string, number>(); // api-request id → when it was sent
  const said = new Map<string, Partial<TrajectoryRecord>>(); // turn → what the transcript says of it besides its records
  let turn: string | null = sub?.turnId ?? null;
  let lastAt = 0; // when the last line that was not a reply was written: a reply with no api-request starts there
  let cost: { start: unknown; total: number } | null = null;
  let compaction: TrajectoryRecord | null = null; // the last one, waiting for its summary
  const push = (r: TrajectoryRecord) => (records.push(r), r);
  const turnSaid = (more: Partial<TrajectoryRecord>) => turn && said.set(turn, { ...said.get(turn), ...more });
  const startTurn = (id: string, at: number, input: string, via?: TrajectoryRecord["via"], name?: string) => {
    turn = id;
    push({ id, turnId: id, kind: "user", start: at, input, ...(name ? { name } : {}), ...(via ? { via } : {}) });
    if (via) turnSaid({ via });
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = ms(e.timestamp);
    if (e.type === "api-request") {
      if (at !== undefined && e.id) requests.set(e.id, at);
      continue;
    }
    if (e.type === "cost-state" && !sub) {
      const total = num(e.totalCostUSD);
      const spent = cost && cost.start === e.startTime ? total - cost.total : total;
      cost = { start: e.startTime, total };
      const was = turn ? (said.get(turn)?.costUSD ?? 0) : 0;
      if (spent > 0) turnSaid({ costUSD: was + spent });
      continue;
    }
    if (at === undefined || (e.isSidechain && !sub)) continue;

    if (e.type === "system") {
      lastAt = at;
      if (e.subtype === "compact_boundary") {
        const m = e.compactMetadata ?? {};
        compaction = push({ id: e.uuid ?? `compaction:${at}`, turnId: turn, kind: "compaction", start: at - num(m.durationMs), end: at, name: m.trigger ?? "auto", input: { tokensBefore: m.preTokens }, output: { tokensAfter: m.postTokens } });
      } else if (e.subtype === "turn_duration") turnSaid({ end: at });
      continue;
    }

    // A message typed while it worked, taken in between two tool calls: the history shows it as the person's, there.
    const q = e.type === "attachment" ? e.attachment : null;
    if (q?.type === "queued_command" && q.commandMode === "prompt" && typeof q.prompt === "string" && !sub) {
      startTurn(e.uuid ?? `queued:${at}`, at, q.prompt.trim());
      lastAt = at;
      continue;
    }
    if (e.type === "user") {
      lastAt = at;
      if (e.isMeta) continue;
      const content = e.message?.content;
      const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const b of results) {
        const call = tools.get(b.tool_use_id);
        if (!call) continue;
        const r = e.toolUseResult;
        // An Agent call that went to the background returns at once: its sub-agent ends later (its notification).
        if (call.kind === "subagent" && (r?.status === "async_launched" || r?.isAsync)) {
          call.background = true;
          continue;
        }
        call.end = at;
        call.output = call.kind === "subagent" && typeof r?.content === "object" ? resultText(r.content) : resultText(b.content);
        if (b.is_error || r?.interrupted) call.error = true;
      }
      if (results.length) continue;
      const words = unpasted(blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
      if (!words.trim()) continue;
      if (e.isCompactSummary) {
        if (compaction) compaction.output = { ...(compaction.output as object), summary: words };
        continue;
      }
      if (sub) continue; // its prompt: the call's input already
      if (/^\s*<local-command-(stdout|stderr|caveat)>/.test(words)) continue;
      if (INTERRUPTED.test(words)) {
        turnSaid({ status: "interrupted" });
        continue;
      }
      const note = notification(words);
      if (note || words.trimStart().startsWith("<task-notification>")) {
        const call = note && tools.get(note.toolUseId);
        if (call) {
          call.end ??= at;
          if (note.outcome.status && note.outcome.status !== "completed") call.error = true;
        }
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(words)?.[1]?.trim();
        startTurn(e.uuid ?? `notification:${at}`, at, summary ?? "A background task finished.", "harness", "background");
        continue;
      }
      const cmd = /^<command-name>(.*?)<\/command-name>/.exec(words);
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(words)?.[1]?.trim();
      startTurn(e.uuid ?? `user:${at}`, at, cmd ? cmd[1] + (args ? ` ${args}` : "") : words.trim());
      // A /compact is written after the compaction it made (whose line comes first, though it happened after): its turn's.
      if (cmd?.[1] === "/compact" && compaction?.name === "manual" && compaction.start >= at - 1000) compaction.turnId = turn;
      continue;
    }
    if (e.type !== "assistant") continue;

    const m = e.message ?? {};
    const key = String(m.id ?? e.uuid);
    let reply = replies.get(key);
    if (!reply) {
      const start = (e.requestRef && requests.get(e.requestRef)) || lastAt || at;
      reply = push({ id: `reply:${key}`, turnId: turn, kind: "assistant", start, end: at, ...(sub ? { parent: sub.parent } : {}) });
      replies.set(key, reply);
    }
    reply.end = Math.max(reply.end ?? at, at);
    if (m.model && m.model !== "<synthetic>") reply.model = reply.name = m.model;
    if (m.usage && m.model !== "<synthetic>") reply.usage = usageOf(m.usage);
    if (e.isApiErrorMessage) reply.error = true;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === "text" && b.text?.trim()) reply.output = [reply.output, b.text].filter(Boolean).join("\n\n");
      else if (b.type === "thinking" && b.thinking?.trim()) reply.thinking = [reply.thinking, b.thinking].filter(Boolean).join("\n\n");
      else if (b.type === "tool_use" && b.id && !tools.has(b.id)) {
        const agent = AGENT_TOOLS.has(b.name);
        const call = push({ id: b.id, turnId: turn, kind: agent ? "subagent" : "tool", start: at, name: agent ? String(b.input?.subagent_type ?? "general-purpose") : b.name, input: b.input, ...(sub ? { parent: sub.parent } : {}), ...(agent && b.input?.run_in_background ? { background: true } : {}) });
        tools.set(b.id, call);
      }
    }
  }

  // Each sub-agent: its own transcript, under its call (and the ones it started, under it).
  const seen = sub?.seen ?? new Set<string>();
  for (const call of [...tools.values()].filter((t) => t.kind === "subagent")) {
    if (seen.has(call.id)) continue;
    seen.add(call.id);
    const found = subagents(call.id);
    if (!found) continue;
    if (found.meta?.agentType) call.name = found.meta.agentType;
    const inner = claudeTrajectory(found.text, subagents, { parent: call.id, turnId: call.turnId, seen });
    for (const r of inner) if (r.kind === "assistant" && r.parent === call.id) call.usage = addUsage(call.usage, r.usage);
    const last = Math.max(...inner.map((r) => r.end ?? r.start));
    // Still going (no end yet): its last step says how far it got, not that it ended.
    if (call.end === undefined && found.meta && (found.meta as { finished?: boolean }).finished && Number.isFinite(last)) call.end = last;
    const answer = [...inner].reverse().find((r) => r.kind === "assistant" && r.parent === call.id && r.output);
    if (answer && call.output === undefined) call.output = answer.output;
    records.push(...inner);
  }
  if (sub) return records;
  return [...turnsOf(records, said), ...records].sort(byTime);
}
