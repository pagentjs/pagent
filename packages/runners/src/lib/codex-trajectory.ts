// A Codex thread as a trajectory (lib/trajectory.ts), from its rollout (the thread's .jsonl; codex-cli 0.163.0).
//
// What the rollout says, line by line (each with its timestamp):
//   event_msg task_started / task_complete (duration_ms, time_to_first_token_ms) / turn_aborted   a Codex turn
//   event_msg item_completed   a finished item, with the id the app-server gives it (thread/turns/list: the history's
//                              ids) and when it started and completed (started_at_ms, completed_at_ms): UserMessage,
//                              AgentMessage, Reasoning, CommandExecution (its duration; started_at_ms is when it
//                              completed), FileChange, McpToolCall, WebSearch, CollabAgentToolCall (spawn_agent, wait,
//                              send_input, close_agent), ContextCompaction
//   response_item function_call / custom_tool_call   the model asked for a tool (call_id: the item's id): when the call
//                              started, so a call still running is there before it completes
//   token_usage_record         a request's tokens (response_id), written when its response completed
//   compacted                  the context was compacted here (message: the summary); also an item, ContextCompaction
//   turn_context               the model of the turns that follow
// A request (an "assistant" record) runs from the last thing sent to it (the turn's message, a tool's output) to its
// token usage record. A sub-agent is a thread of its own, with a rollout of its own (session_meta.parent_thread_id):
// read into records under its spawn. A rollout from an older Codex without item_completed lines gets its messages and
// requests, not its calls' ids or times.
import { addUsage, byTime, ms, turnsOf, type TrajectoryRecord, type TrajectoryUsage } from "./trajectory.ts";

/** A sub-agent's rollout text, by its thread id. */
export type ChildSource = (threadId: string) => string | null;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Codex counts cached input inside its input; here input is what was not from the cache, as for Claude. */
const usageOf = (u: any): TrajectoryUsage => ({ input: Math.max(0, num(u?.input_tokens) - num(u?.cached_input_tokens)), cacheRead: num(u?.cached_input_tokens), cacheWrite: num(u?.cache_write_input_tokens), output: num(u?.output_tokens), ...(num(u?.reasoning_output_tokens) ? { reasoning: num(u.reasoning_output_tokens) } : {}) });

const textOf = (content: unknown) => (Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : typeof content === "string" ? content : "");

/** A command as one line: the shell's own wrapper ("/bin/zsh -lc '…'") left out. */
const commandOf = (c: unknown): string => {
  const parts = Array.isArray(c) ? c.map(String) : [String(c ?? "")];
  return parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1]) ? parts[2] : parts.join(" ");
};

/** A finished tool item as the history names it (codex-items.ts toolOf): its name, input, output, and whether it failed. */
function toolItem(it: any): { name: string; input: unknown; output: unknown; error: boolean } | null {
  const failed = it.status === "failed" || it.status === "declined" || (it.exit_code != null && it.exit_code !== 0);
  switch (it.type) {
    case "CommandExecution":
      return { name: "shell", input: { command: commandOf(it.command) }, output: it.aggregated_output ?? "", error: failed };
    case "FileChange": {
      const changes = Object.entries(it.changes ?? {}).map(([path, c]: [string, any]) => ({ path, kind: c?.type, ...(c?.unified_diff ? { diff: c.unified_diff } : c?.content ? { content: c.content } : {}) }));
      return { name: "apply_patch", input: { changes }, output: [it.stdout, it.stderr].filter(Boolean).join("\n"), error: failed };
    }
    case "McpToolCall":
      return { name: `mcp__${it.server}__${it.tool}`, input: it.arguments ?? {}, output: it.error?.message ?? textOf(it.result?.content), error: failed || !!it.error };
    case "WebSearch":
      return { name: "web_search", input: { query: it.query }, output: "", error: failed };
    case "CollabAgentToolCall":
      return { name: snake(String(it.tool ?? "agents")), input: { ...(it.prompt ? { prompt: it.prompt } : {}), ...(it.receiver_thread_ids?.length ? { agents: it.receiver_thread_ids } : {}) }, output: it.agents_states ?? {}, error: failed };
    default:
      return null;
  }
}

/** The whole thread (or, with `sub`, a sub-agent's: its records under its spawn, in that spawn's turn). */
export function codexTrajectory(text: string, child: ChildSource = () => null, sub?: { parent: string; turnId: string | null; seen: Set<string>; end?: number }): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  const calls = new Map<string, TrajectoryRecord>(); // call_id = the item's id → its record
  const said = new Map<string, Partial<TrajectoryRecord>>();
  const lines = text.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
  const items = lines.some((e) => e.payload?.type === "item_completed"); // an older rollout has none
  let turn: string | null = sub?.turnId ?? null;
  let model: string | undefined;
  let lastAt = 0; // the last thing sent to the model: a request starts there
  let step: { thinking: string[]; output: string[] } = { thinking: [], output: [] };
  let pending: TrajectoryRecord | null = null; // a compaction's summary line, before (or without) its item
  const push = (r: TrajectoryRecord) => (records.push(r), r);
  const parent = sub ? { parent: sub.parent } : {};
  const turnSaid = (more: Partial<TrajectoryRecord>) => turn && said.set(turn, { ...said.get(turn), ...more });
  const call = (id: string, at: number, name: string, input: unknown, kind: TrajectoryRecord["kind"] = "tool") => {
    let r = calls.get(id);
    if (!r) calls.set(id, (r = push({ id, turnId: turn, kind, start: at, name, input, ...parent })));
    return r;
  };

  for (const e of lines) {
    const at = ms(e.timestamp);
    const p = e.payload ?? {};
    if (at === undefined) continue;
    if (e.type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (e.type === "compacted") {
      pending = push({ id: `compaction:${at}`, turnId: turn, kind: "compaction", start: at, end: at, name: "auto", output: { summary: typeof p.message === "string" ? p.message : "" }, ...parent });
      continue;
    }
    if (e.type === "token_usage_record" || (!items && e.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage)) {
      const u = e.type === "token_usage_record" ? p.usage : p.info.last_token_usage;
      push({
        id: p.response_id ?? `request:${at}`,
        turnId: turn,
        kind: "assistant",
        start: lastAt || at,
        end: at,
        ...(model ? { name: model, model } : {}),
        usage: usageOf(u),
        ...(step.output.length ? { output: step.output.join("\n\n") } : {}),
        ...(step.thinking.length ? { thinking: step.thinking.join("\n\n") } : {}),
        ...parent,
      });
      step = { thinking: [], output: [] };
      continue;
    }
    if (e.type === "response_item") {
      // A call as the model made it: its start (the item says when it completed).
      if ((p.type === "function_call" || p.type === "custom_tool_call") && p.call_id && p.name !== "spawn_agent") {
        let input: unknown = p.input ?? p.arguments;
        try {
          if (typeof input === "string" && p.type === "function_call") input = JSON.parse(input);
        } catch {}
        const r = call(p.call_id, at, p.name, input);
        if (!items) r.name = p.name;
      } else if (!items && (p.type === "function_call_output" || p.type === "custom_tool_call_output") && calls.has(p.call_id)) {
        const r = calls.get(p.call_id)!;
        (r.end = at), (r.output = typeof p.output === "string" ? p.output : (p.output?.content ?? JSON.stringify(p.output)));
        lastAt = at;
      } else if (!items && p.type === "message" && p.role === "assistant") step.output.push(textOf(p.content));
      else if (!items && p.type === "message" && p.role === "user" && !sub) {
        const words = textOf(p.content);
        if (/^\s*<(environment_context|user_instructions|subagent_notification)/.test(words)) continue;
        turn = `message:${at}`;
        push({ id: turn, turnId: turn, kind: "user", start: at, input: words });
        lastAt = at;
      }
      continue;
    }
    if (e.type !== "event_msg") continue;
    if (p.type === "task_started") {
      lastAt = at;
      continue;
    }
    if (p.type === "task_complete" || p.type === "turn_aborted") {
      if (sub) sub.end = at;
      turnSaid({ end: at, status: p.type === "turn_aborted" ? "interrupted" : "completed", ...(num(p.time_to_first_token_ms) ? { ttftMs: num(p.time_to_first_token_ms) } : {}) });
      continue;
    }
    if (p.type !== "item_completed" || !p.item) continue;
    const it = p.item;
    const start = ms(p.started_at_ms) ?? at;
    const end = ms(p.completed_at_ms) ?? at;
    if (it.type === "UserMessage") {
      lastAt = end;
      if (sub) continue; // its prompt: the spawn's input already
      turn = it.id;
      push({ id: it.id, turnId: it.id, kind: "user", start, input: textOf(it.content) });
    } else if (it.type === "AgentMessage") step.output.push(textOf(it.content));
    else if (it.type === "Reasoning") step.thinking.push([...(it.summary_text ?? it.summary ?? []), ...(it.raw_content ?? it.content ?? [])].map((x: any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("\n"));
    else if (it.type === "ContextCompaction") {
      if (pending && pending.turnId === turn) (pending.id = it.id), (pending.start = start), (pending.end = end);
      else push({ id: it.id, turnId: turn, kind: "compaction", start, end, name: "auto", ...parent });
      pending = null;
      lastAt = end;
    } else if (it.type === "CollabAgentToolCall" && it.tool === "spawn_agent") {
      const r = call(it.id, start, "agent", { prompt: it.prompt, ...(it.model ? { model: it.model } : {}) }, "subagent");
      r.kind = "subagent";
      r.name = it.receiver_agents?.[0]?.agent_nickname ?? it.agent_nickname ?? "agent";
      r.input = { prompt: it.prompt, ...(it.model ? { model: it.model } : {}) };
      (r as { thread?: string }).thread = it.receiver_thread_ids?.[0];
      if (it.status === "failed") r.error = true;
      lastAt = end;
    } else {
      const tool = toolItem(it);
      if (!tool) continue;
      const asked = calls.has(it.id);
      const r = call(it.id, start, tool.name, tool.input);
      // A command's item says when it completed and how long it ran; its call, when it was asked for.
      const ran = it.duration ? num(it.duration.secs) * 1000 + num(it.duration.nanos) / 1e6 : 0;
      if (it.type === "CommandExecution" && !asked) r.start = end - ran;
      (r.name = tool.name), (r.input = tool.input), (r.output = tool.output), (r.end = end);
      if (tool.error) r.error = true;
      lastAt = end;
    }
  }

  // Each sub-agent: its own thread's rollout, under its spawn (and the ones it started, under it).
  const seen = sub?.seen ?? new Set<string>();
  for (const r of records.filter((r) => r.kind === "subagent")) {
    const thread = (r as { thread?: string }).thread;
    delete (r as { thread?: string }).thread;
    if (!thread || seen.has(thread)) continue;
    seen.add(thread);
    const rollout = child(thread);
    if (!rollout) continue;
    const it = { parent: r.id, turnId: r.turnId, seen, end: undefined as number | undefined };
    const inner = codexTrajectory(rollout, child, it);
    for (const x of inner) if (x.kind === "assistant" && x.parent === r.id) r.usage = addUsage(r.usage, x.usage);
    // It ended with its own turn (its task_complete); still going, it has no end.
    if (it.end !== undefined) r.end = it.end;
    else delete r.end;
    const answer = [...inner].reverse().find((x) => x.kind === "assistant" && x.parent === r.id && x.output);
    if (answer) r.output = answer.output;
    records.push(...inner);
  }
  if (sub) return records;
  return [...turnsOf(records, said), ...records].sort(byTime);
}
