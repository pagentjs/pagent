// A runner for any harness that speaks ACP (acp.ts): one runner, many harnesses. A harness is a profile (the command
// that starts its ACP agent, its tools' names, the mode that takes edits, its TUI if one can attach); everything else is
// the same for all of them (SPEC 13.18).
//
// Turns go to a thread (the contract's "thread"): the agent's session is a long-lived ACP agent process in the daemon
// (the session op), which the app's messages go to; one at a time (ACP has no steering: a message during a turn waits
// for the next, in the session). What the runner saw of each session it keeps (acp-record.ts), so the history, the
// trajectory, the token use and the last words read without starting the agent. pagent's additions per agent: its
// identity in the agent process's environment (one process per agent), the engine's skills and its system prompt at
// the head of a new session's first message (ACP has no system prompt; a profile may do better), the MCP servers it
// declares (session/new takes them), and its permission requests as cards in the app.
//
// What ACP cannot give, and what is done instead:
//   a transcript after a restart: the runner's own record (or the harness's own export: opencode);
//   a trajectory: the record's times, as seen live (ACP has no times); per-request tokens and costs only where the
//     harness says (opencode's export);
//   a TUI: only where the harness has one that attaches to the same session (opencode attach); else none (can.terminal);
//   usage: what each prompt's result and usage_update say (ACP has no account limits);
//   strangers, holder, follow: none (no tool-less turn, no registry of other processes, nothing typed into a TUI).
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UIMessage, UIMessageChunk } from "ai";
import { Acp, acpMcpServers, type AcpInit, type AcpUpdate } from "./acp.ts";
import { addUsage, historyOf, keep, lastOf, readRecord, readTail, recordFile, trajectoryOf, usageOf, usageOfResult, type Seen } from "./acp-record.ts";
import { Reply, statusOf } from "./acp-turns.ts";
import { loadSession, realPath, saveSession } from "./common.ts";
import type { AgentInput, Command, Describe, Op } from "./contract.ts";
import { askApp } from "./permission.ts";
import { meta, type Classify, type ToolMeta } from "./tools.ts";
import type { TrajectoryRecord } from "./trajectory.ts";
import type { SessionUsage } from "./usage.ts";

export type Input = AgentInput & { op: Op; from?: string; to?: string };

/** A harness on ACP. */
export type Profile = {
  /** What an agent's `cli` names it (the runner's file name), and what people call it. */
  id: string;
  title: string;
  /** Its ACP agent: the command, its arguments, what it adds to the environment. port: where its own server listens (attach). */
  agent(input: Input, port?: number): { command: string; args: string[]; env?: Record<string, string> };
  /** Its tools' names, as what they do (tools.ts); a name it does not know is read by its ACP kind. */
  classify?: Classify;
  /** The session mode an agent of an app works in (edits its own files without asking; anything else asks), if any. */
  mode?: string;
  /**
   * Its TUI attaches to the agent's session where it runs (its ACP agent is a server: `endpoint` is where): the command.
   * None: no terminal.
   */
  attach?(input: Input & { thread: string; endpoint?: string }): Omit<Command, "type"> | null;
  /** Where its ACP agent's own server listens, when it has one a TUI attaches to (a free port is picked). */
  serves?: boolean;
  /** The command that resumes a session outside the app. */
  resume?(session: string, cwd: string): string;
  /**
   * Its own record of a session, when it has one better than the runner's (a history with what was typed outside the
   * app, a timeline with each request's tokens): each returns null when it cannot say, and the runner's record answers.
   */
  native?: {
    history?(input: Input, session: string): Promise<{ messages: UIMessage[]; file?: string; watch?: string[] } | null>;
    trajectory?(input: Input, session: string): Promise<{ records: TrajectoryRecord[]; file?: string; watch?: string[] } | null>;
    usage?(input: Input, session: string): Promise<SessionUsage | null>;
  };
};

const out = (o: UIMessageChunk | Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
const exit = (code: number) => process.stdout.write("", () => process.exit(code));

/** A pinned agent (adopted session, or a folder of its own) keeps its session; else the folder's (its latest, below). */
const pinned = (input: Input) => !!input.seedSession || !!input.ownSession;

/** The session the quick ops read: the one the agent's session process has open, else the one it last had. */
const sessionOf = (input: Input): string | null => input.thread ?? loadSession(input.stateDir, input.seedSession);

/**
 * pagent's words for a new session, at the head of its first message (ACP has no system prompt): the agent's system
 * prompt and the engine's skills, which it reads when it needs them (as Codex does: it has no plugin folder).
 */
function preamble(input: Input): string {
  const skills = [...(input.pluginDirs ?? []).flatMap((d) => skillFiles(join(d, "skills"))), ...(input.skills ?? []).map((d) => join(d, "SKILL.md"))];
  const lines = [
    input.systemPrompt ?? "",
    skills.length ? `Skills you can load (read the file when the task needs it):\n${skills.map((s) => `- ${s}`).join("\n")}` : "",
  ].filter(Boolean);
  return lines.length ? `<pagent-instructions>\n${lines.join("\n\n")}\n</pagent-instructions>\n\n` : "";
}
const skillFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((d) => join(dir, d, "SKILL.md")).filter((f) => existsSync(f)) : []);

/** A free port on localhost, for an agent's own server. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

// ---------------------------------------------------------------- the session

/** What the app asks of a permission request: the call, as the profile's table and ACP say it. */
function permissionOf(profile: Profile, toolCall: any, known?: string): { tool: string; input: unknown; meta: ToolMeta } {
  const reply = new Reply(undefined, profile.classify);
  let m: ToolMeta = meta("other");
  let tool = String(toolCall?.title ?? "tool");
  reply.update({ sessionUpdate: "tool_call", ...toolCall, ...(known ? { _meta: { ...toolCall?._meta, toolName: known } } : {}) }, Date.now());
  const p = reply.parts[0] as any;
  if (p) ((tool = p.toolName), (m = p.toolMetadata ?? m));
  return { tool, input: toolCall?.rawInput ?? {}, meta: m };
}

async function sessionOp(profile: Profile, input: Input, commands: AsyncIterator<string>) {
  const port = profile.serves ? await freePort() : undefined;
  const a = profile.agent(input, port);
  const acp = new Acp(a.command, a.args, { cwd: input.cwd, env: { ...process.env, ...input.env, ...a.env } });
  let started = false; // ready said: from then on, the agent going away ends the session (before it, its failure says)
  let closing = false;
  /** Stop the agent and what it started (its process group), then this process. */
  const end = async (code: number) => {
    closing = true;
    await acp.close();
    exit(code);
  };
  void acp.closed.then((code) => {
    if (!started || closing) return;
    console.error(`${profile.title}'s ACP agent exited (${code})`);
    void end(1); // what it started may still be there
  });
  let init: AcpInit;
  let sessionId: string;
  let fresh = false;
  const mcpServers = acpMcpServers(input.mcps);
  try {
    init = await acp.initialize();
    const caps = init.agentCapabilities ?? {};
    // A declared session (seedSession, adopted) is the person's: one that does not open is an error. One the runner
    // remembers (stateDir/session.json) or the folder's latest that does not open any more (the harness lost it): a new one.
    const remembered = existsSync(join(input.stateDir, "session.json"));
    let known = pinned(input) ? loadSession(input.stateDir, input.seedSession) : null;
    const declared = pinned(input) && !remembered && !!input.seedSession;
    // The folder is the session: its latest, as the harness lists them (or the one the agent last had).
    if (!pinned(input) && caps.sessionCapabilities?.list) {
      const listed = await acp.call("session/list", { cwd: realPath(input.cwd) }).catch(() => null);
      const latest = (listed?.sessions ?? []).filter((s: any) => !s.cwd || realPath(s.cwd) === realPath(input.cwd)).sort((x: any, y: any) => String(y.updatedAt ?? "").localeCompare(String(x.updatedAt ?? "")))[0];
      known = latest?.sessionId ?? loadSession(input.stateDir);
    } else if (!pinned(input)) known = loadSession(input.stateDir);
    if (known) {
      try {
        // Open it without its conversation replayed when the agent can (resume); else load it, and ignore the replay.
        if (caps.sessionCapabilities?.resume) await acp.call("session/resume", { sessionId: known, cwd: input.cwd, mcpServers });
        else await acp.call("session/load", { sessionId: known, cwd: input.cwd, mcpServers });
      } catch (e) {
        if (declared || acp.failure || acp.child.exitCode !== null) throw e;
        console.error(`${profile.title}: session ${known} does not open any more (${(e as Error).message}); starting a new one`);
        known = null;
      }
    }
    if (known) sessionId = known;
    else {
      sessionId = (await acp.call("session/new", { cwd: input.cwd, mcpServers })).sessionId;
      fresh = true;
    }
    saveSession(input.stateDir, sessionId);
    if (profile.mode) await acp.call("session/set_mode", { sessionId, modeId: profile.mode }).catch((e) => console.error(`set_mode ${profile.mode}: ${e.message}`));
  } catch (e) {
    out({ type: "failed", errorText: acp.failure ?? `${profile.title} (ACP): ${(e as Error).message}` });
    return end(2);
  }
  const record = recordFile(input.stateDir, sessionId);
  // The session's token use, kept here as it goes (not read again from the whole record at every turn's end).
  let usage = usageOf(readRecord(record));
  const note = (seen: Seen) => {
    keep(record, seen);
    usage = addUsage(usage, seen);
  };
  started = true;
  out({ type: "ready", threadId: sessionId, ...(port ? { endpoint: `http://127.0.0.1:${port}` } : {}) });

  // One turn at a time: a message during a turn waits for it (ACP does not steer one into a turn in progress).
  type Ask = { run: string; message: string; meta?: unknown };
  const queue: Ask[] = [];
  let turn = null as { id: string; lines: string[]; reply: Reply; ended: boolean } | null;
  const emit = (o: Record<string, unknown>) => {
    const line = JSON.stringify(o);
    turn?.lines.push(line);
    process.stdout.write(line + "\n");
  };
  const asking = new Map<string, AbortController>(); // permission requests the app has not answered

  acp.onUpdate = (sid, u: AcpUpdate) => {
    if (sid !== sessionId) return;
    // An update outside a turn of the app's (a turn its TUI started): kept, not shown live (the history shows it).
    note({ t: Date.now(), u });
    if (!turn || turn.ended) return;
    if (u.sessionUpdate === "usage_update") return;
    turn.reply.update(u);
  };

  acp.onRequest = async (method, p) => {
    if (method !== "session/request_permission") throw Object.assign(new Error(`pagent does not offer ${method}`), { code: -32601 });
    const options: { optionId: string; kind?: string }[] = p.options ?? [];
    const pick = (allow: boolean) => (options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((o) => String(o.kind).startsWith(allow ? "allow" : "reject")))?.optionId;
    if (!input.permissionUrl) return { outcome: { outcome: "cancelled" } };
    const ctl = new AbortController();
    const id = String(p.toolCall?.toolCallId ?? Math.random());
    asking.set(id, ctl);
    try {
      const r = await askApp(input.permissionUrl, permissionOf(profile, p.toolCall, turn?.reply.toolName(String(p.toolCall?.toolCallId ?? ""))), ctl.signal);
      // No decision (someone watches its TUI, which asks itself): the request stays until the turn ends.
      if (!r.decision) return await new Promise((resolve) => ctl.signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true }));
      const optionId = pick(r.decision.allow);
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    } catch {
      return { outcome: { outcome: "cancelled" } };
    } finally {
      asking.delete(id);
    }
  };

  let first = fresh;
  const next = async () => {
    if (turn || !queue.length) return;
    const ask = queue.shift()!;
    const userId = `u-${ask.run}`;
    turn = { id: ask.run, lines: [], reply: new Reply((c) => emit(c as Record<string, unknown>), profile.classify), ended: false };
    emit({ type: "turn", turnId: turn.id });
    // No id: what the harness keeps the message under is its own (the engine finds it in the history by its words).
    emit({ type: "user", turnId: turn.id, text: ask.message, clientId: ask.run, meta: ask.meta });
    note({ t: Date.now(), user: { id: userId, text: ask.message } });
    const text = (first ? preamble(input) : "") + ask.message;
    first = false;
    let status = "completed";
    let errorText = "";
    try {
      const r = await acp.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      status = statusOf(r?.stopReason);
      const said = usageOfResult(r);
      note({ t: Date.now(), end: { stopReason: String(r?.stopReason ?? "end_turn"), ...(said ? { usage: said } : {}) } });
    } catch (e) {
      status = "failed";
      errorText = (e as Error).message;
      note({ t: Date.now(), end: { stopReason: "failed" } });
    }
    for (const c of asking.values()) c.abort();
    const t = turn!;
    t.reply.end();
    t.ended = true;
    if (errorText) emit({ type: "error", errorText });
    if (usage) emit({ type: "data-usage", data: { ...usage }, transient: true });
    emit({ type: "turn-end", turnId: t.id, status, text: t.reply.answer.trim() });
    turn = null;
    void next();
  };

  for (;;) {
    const line = await commands.next();
    if (line.done) break; // the daemon closed stdin: it is going away
    let c: any;
    try {
      c = JSON.parse(line.value);
    } catch {
      continue;
    }
    if (c.op === "ask") {
      queue.push({ run: String(c.run), message: String(c.message ?? ""), meta: c.meta });
      void next();
    } else if (c.op === "interrupt") {
      // The messages waiting for the turn go with it: each one's run hears it ended (else it stays busy for ever).
      for (const dropped of queue.splice(0)) out({ type: "ask-failed", run: dropped.run, errorText: "interrupted" });
      if (turn) acp.notify("session/cancel", { sessionId });
    } else if (c.op === "state") {
      out({ type: "ready", threadId: sessionId, ...(port ? { endpoint: `http://127.0.0.1:${port}` } : {}) });
      for (const l of turn?.lines ?? []) process.stdout.write(l + "\n");
    } else if (c.op === "stop") break;
  }
  await end(0);
}

// ---------------------------------------------------------------- the quick ops

async function historyOp(profile: Profile, input: Input) {
  const session = sessionOf(input);
  if (!session) return out({ type: "history", messages: [] });
  const native = await profile.native?.history?.(input, session).catch(() => null);
  if (native) return out({ type: "history", ...native });
  const file = recordFile(input.stateDir, session);
  out({ type: "history", messages: historyOf(readRecord(file), profile.classify), ...(existsSync(file) ? { file } : {}) });
}

async function trajectoryOp(profile: Profile, input: Input) {
  const session = sessionOf(input);
  if (!session) return out({ type: "trajectory", records: [] });
  const native = await profile.native?.trajectory?.(input, session).catch(() => null);
  if (native) return out({ type: "trajectory", ...native });
  const file = recordFile(input.stateDir, session);
  out({ type: "trajectory", records: trajectoryOf(readRecord(file)), ...(existsSync(file) ? { file } : {}) });
}

async function usageOp(profile: Profile, input: Input) {
  const session = sessionOf(input);
  const file = session ? recordFile(input.stateDir, session) : null;
  const usage = session ? ((await profile.native?.usage?.(input, session).catch(() => null)) ?? usageOf(readRecord(file!))) : null;
  out({ type: "usage", usage, file: file && existsSync(file) ? file : null });
}

/** Where it stopped: from the record's end (its last turns), the whole record only when they said nothing. */
function lastOp(profile: Profile, input: Input) {
  const session = sessionOf(input);
  const file = session ? recordFile(input.stateDir, session) : null;
  const tail = file ? readTail(file) : null;
  let l = tail ? lastOf(tail.seen, profile.classify) : { text: null, at: null, lastAt: null };
  if (file && tail && !l.text && !tail.whole) l = lastOf(readRecord(file), profile.classify);
  out({ type: "last", ...l, title: null, file: file && existsSync(file) ? file : null });
}

function infoOp(profile: Profile, input: Input) {
  const session = sessionOf(input);
  out({ type: "info", sessionId: session, resume: session && profile.resume ? `cd ${JSON.stringify(input.cwd)} && ${profile.resume(session, input.cwd)}` : null });
}

/** The agent's folder moved: its session is the one it had (the harness keys it by id), remembered in its state. */
function moveOp(input: Input) {
  const had = loadSession(input.stateDir, input.seedSession);
  if (had) saveSession(input.stateDir, had);
  out({ type: "moved", sessions: had ? 1 : 0 });
}

function interactiveOp(profile: Profile, input: Input) {
  const cmd = input.thread && profile.attach ? profile.attach({ ...input, thread: input.thread }) : null;
  if (!cmd) return out({ type: "error", errorText: `${profile.title} has no TUI that attaches to the agent's session` });
  out({ type: "command", ...cmd });
}

function describeOp(profile: Profile) {
  const ops: Op[] = ["last", "info", "usage", "trajectory", "move", ...(profile.attach ? (["interactive"] as Op[]) : [])];
  out({ type: "describe", harness: { id: profile.id, title: profile.title }, turns: "thread", ops, interject: false } satisfies Describe);
}

/** The runner: the op on the first line of stdin, its answer on stdout (a session reads its commands from the lines after). */
export async function runAcp(profile: Profile) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  const input = JSON.parse(first.done ? "{}" : first.value) as Input;
  if (input.op === "describe") describeOp(profile);
  else if (input.op === "session") await sessionOp(profile, input, lines);
  else if (input.op === "history") await historyOp(profile, input);
  else if (input.op === "trajectory") await trajectoryOp(profile, input);
  else if (input.op === "usage") await usageOp(profile, input);
  else if (input.op === "last") lastOp(profile, input);
  else if (input.op === "info") infoOp(profile, input);
  else if (input.op === "move") moveOp(input);
  else if (input.op === "interactive") interactiveOp(profile, input);
  else out({ type: "error", errorText: `${profile.title} (ACP) has no op ${input.op}` });
  if (input.op !== "session") exit(0);
}
