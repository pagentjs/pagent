// opencode's tools, as what they do (tools.ts), and its own record of a session (`opencode export <id>`: the session's
// messages, each an assistant message per request with its times, tokens and cost, its parts with each tool's input,
// output and times) as pagent's history, trajectory and token use. opencode 1.19.3. Read only; opencode's database
// stays the truth.
import { execFile } from "node:child_process";
import type { UIMessage } from "ai";
import { commonOf, mcpServer, meta, stepsOf, type Classify, type ToolMeta } from "./tools.ts";
import { byTime, turnsOf, type TrajectoryRecord } from "./trajectory.ts";
import type { SessionUsage } from "./usage.ts";

export const opencodeTool: Classify = (name, input): ToolMeta => {
  const { o, files, command, query, url } = commonOf(input);
  switch (name) {
    case "bash":
      return meta("command", { command });
    case "read":
      return meta("read", { files });
    case "write":
      return meta("write", { files });
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return meta("edit", { files });
    case "glob":
    case "grep":
    case "list":
    case "codesearch":
      return meta("search", { query: query ?? (typeof o.path === "string" ? o.path : undefined) });
    case "webfetch":
      return meta("web", { url });
    case "websearch":
      return meta("webSearch", { query });
    case "task":
      return meta("subagent");
    case "skill":
      return meta("skill");
    case "todowrite":
      return meta("steps", Array.isArray(o.todos) ? { steps: { set: stepsOf(o.todos) } } : {});
    case "todoread":
      return meta("other");
    case "question":
      return meta("ask");
    case "plan_enter":
      return meta("planMode");
    case "plan_exit":
      return meta("proposal", { plan: typeof o.plan === "string" ? o.plan : "", asks: true });
  }
  const server = mcpServer(name);
  return server ? meta("mcp", { server }) : meta("other");
};

type Part = { id: string; type: string; text?: string; tool?: string; callID?: string; state?: any; time?: { start?: number; end?: number }; tokens?: any; cost?: number };
type Message = { info: { id: string; role: "user" | "assistant"; time: { created: number; completed?: number }; parentID?: string; modelID?: string; cost?: number; tokens?: any; error?: any }; parts: Part[] };
export type Export = { info: { id: string; title?: string; time?: { created: number; updated: number } }; messages: Message[] };

/** The session as opencode exports it (null: opencode is not there, or does not know it). */
export function exportSession(bin: string, session: string, cwd: string): Promise<Export | null> {
  return new Promise((resolve) => {
    execFile(bin, ["export", session], { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }, (e, stdout) => {
      if (e) return resolve(null);
      try {
        resolve(JSON.parse(stdout.slice(stdout.indexOf("{"))));
      } catch {
        resolve(null);
      }
    });
  });
}

/** The git commands an agent commits with and looks at what it committed with, without asking (as claude.ts's). */
const GIT_COMMANDS = ["status", "diff", "log", "show", "add", "commit"];

/**
 * What an agent of an app may do without asking (OPENCODE_PERMISSION): its edits, and the commands it reaches its app
 * and commits with. The rest asks (opencode's "ask" is an ACP permission request: a card in the app). The last pattern
 * that matches wins; opencode's "*" is any text, so each command is the command alone and the command with arguments
 * ("git diff", "git diff *"), never "git diff*", which is also `git difftool -x <anything>`. What the agent declares
 * (`allow`, written as Claude Code's rules, the one way pagent documents) maps over: Bash(x:*) is "x" and "x *",
 * Bash(x) "x", WebFetch the web fetch; other rules have nothing to map to.
 */
export function opencodePermission(allow: string[]): { edit: string; bash: Record<string, string>; webfetch: string } {
  const bash: Record<string, string> = { "*": "ask" };
  const command = (c: string) => ((bash[c] = "allow"), (bash[`${c} *`] = "allow"));
  command("pagent");
  for (const c of GIT_COMMANDS) command(`git ${c}`);
  let webfetch = "ask";
  for (const rule of allow) {
    const [, tool, arg] = /^(\w+)(?:\((.*)\))?$/s.exec(rule) ?? [];
    if (tool === "Bash" && arg && /:\*$/.test(arg)) command(arg.replace(/:\*$/, ""));
    else if (tool === "Bash" && arg) bash[arg] = "allow";
    else if (tool === "Bash") bash["*"] = "allow";
    else if (tool === "WebFetch") webfetch = "allow";
  }
  return { edit: "allow", bash, webfetch };
}


const tokensOf = (t: any) => ({ input: Number(t?.input ?? 0), cacheRead: Number(t?.cache?.read ?? 0), cacheWrite: Number(t?.cache?.write ?? 0), output: Number(t?.output ?? 0), ...(t?.reasoning ? { reasoning: Number(t.reasoning) } : {}) });
const textOf = (parts: Part[]) => parts.filter((p) => p.type === "text" && !(p as any).synthetic).map((p) => p.text ?? "").join("");

/** A tool part as a dynamic tool of the conversation. */
function toolPart(p: Part): UIMessage["parts"][number] {
  const s = p.state ?? {};
  const base = { type: "dynamic-tool", toolName: String(p.tool), toolCallId: String(p.callID ?? p.id), input: s.input ?? {}, toolMetadata: opencodeTool(String(p.tool), s.input ?? {}) };
  if (s.status === "completed") return { ...base, state: "output-available", output: s.output ?? "" } as any;
  if (s.status === "error") return { ...base, state: "output-error", errorText: String(s.error ?? "error") } as any;
  return { ...base, state: "input-available" } as any;
}

/**
 * The conversation: each message of the person's (its words: the pagent instructions at the head of a session's first
 * one left out), then every request that answered it as one reply.
 */
export function historyOfExport(e: Export, strip: (text: string) => string): UIMessage[] {
  const out: UIMessage[] = [];
  let reply: UIMessage | null = null;
  for (const m of e.messages) {
    if (m.info.role === "user") {
      out.push({ id: m.info.id, role: "user", parts: [{ type: "text", text: strip(textOf(m.parts)) }] });
      reply = null;
      continue;
    }
    if (!reply) out.push((reply = { id: m.info.id, role: "assistant", parts: [] }));
    reply.parts.push({ type: "step-start" });
    for (const p of m.parts) {
      if (p.type === "text" && p.text?.trim()) reply.parts.push({ type: "text", text: p.text, state: "done" });
      else if (p.type === "reasoning" && p.text?.trim()) reply.parts.push({ type: "reasoning", text: p.text, state: "done" });
      else if (p.type === "tool") reply.parts.push(toolPart(p));
    }
  }
  return out;
}

/** The session as a timeline: each request (an assistant message) with its times, tokens and cost; each call with its own times. */
export function trajectoryOfExport(e: Export, strip: (text: string) => string): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  const said = new Map<string, Partial<TrajectoryRecord>>();
  let turn: string | null = null;
  for (const m of e.messages) {
    if (m.info.role === "user") {
      turn = m.info.id;
      records.push({ id: m.info.id, turnId: turn, kind: "user", start: m.info.time.created, input: strip(textOf(m.parts)) });
      continue;
    }
    const thinking = m.parts.filter((p) => p.type === "reasoning").map((p) => p.text ?? "").join("");
    records.push({
      id: m.info.id,
      turnId: turn,
      kind: "assistant",
      start: m.info.time.created,
      ...(m.info.time.completed ? { end: m.info.time.completed } : {}),
      name: m.info.modelID,
      model: m.info.modelID,
      output: textOf(m.parts),
      ...(thinking ? { thinking } : {}),
      usage: tokensOf(m.info.tokens),
      ...(m.info.error ? { error: true } : {}),
    });
    for (const p of m.parts.filter((p) => p.type === "tool")) {
      const s = p.state ?? {};
      records.push({ id: String(p.callID ?? p.id), turnId: turn, kind: "tool", start: s.time?.start ?? m.info.time.created, ...(s.time?.end ? { end: s.time.end } : {}), name: String(p.tool), input: s.input ?? {}, output: s.output ?? s.error, ...(s.status === "error" ? { error: true } : {}) });
    }
    if (turn) {
      const t = said.get(turn) ?? {};
      said.set(turn, { ...t, costUSD: (t.costUSD ?? 0) + Number(m.info.cost ?? 0) });
    }
  }
  return [...turnsOf(records, said), ...records].sort(byTime);
}

/** Its token use: every request's, summed; the context, what its last request sent. */
export function usageOfExport(e: Export): SessionUsage | null {
  const requests = e.messages.filter((m) => m.info.role === "assistant" && m.info.tokens);
  if (!requests.length) return null;
  const u: SessionUsage = { context: 0, window: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, compactions: 0, requests: requests.length, model: null, at: null };
  for (const m of requests) {
    const t = tokensOf(m.info.tokens);
    u.input += t.input;
    u.cacheRead += t.cacheRead;
    u.cacheWrite += t.cacheWrite;
    u.output += t.output;
    u.context = t.input + t.cacheRead + t.cacheWrite;
    u.model = m.info.modelID ?? u.model;
    u.at = new Date(m.info.time.completed ?? m.info.time.created).toISOString();
  }
  u.compactions = e.messages.filter((m) => m.parts.some((p) => p.type === "compaction")).length;
  return u;
}

