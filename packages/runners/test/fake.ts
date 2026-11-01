#!/usr/bin/env node
// A runner for tests: the runner contract (runners/src/lib/contract.ts) without a harness, a model or a network. Its
// sessions are transcripts it keeps itself (<stateDir>/transcript.jsonl, and one more per /clear in its TUI), so
// history, last words and the transcript watcher work as with a real harness. Declare it with the script's path: agents = { bot: { runner: "/…/fake.ts" } }.
// Its describe says nothing about its turns (only that it answers strangers), so they are headless; fake-tui.ts is the same runner with a TUI,
// fake-thread.ts the same on a shared thread (a long-lived session the TUI is one more client of).
//
// What it does in a turn is written in the message, one step per line starting with "!" (anything else is just text):
//   !sleep <ms>          wait (the turn is busy meanwhile)
//   !say <text>          write a block of the reply
//   !slow <n> <ms>       write n blocks, one every ms, each in the transcript as soon as it is written
//   !sh <command>        run a shell command in the agent's environment (its `pagent` works) and write its output (the
//                        call is kept in the transcript, as Claude Code keeps its Bash calls)
//   !card <path> [JSON]  write a block of the reply that shows that node as a card
//   !own                 write the skills and MCP servers the agent declares, as the runner got them (JSON)
//   !root                write the app's folder, as the runner got it (appRoot)
//   !prompt              write the system prompt, as the runner got it (headless turns)
//   !title <text>        name the session (as Claude Code's ai-title does); the "last" op says the latest
//   !agents <n> <ms>     run n sub-agents side by side (as Claude Code's Agent tool does), each a step every ms for 3
//                        steps, in the generic shape (runners/src/lib/subagents.ts); kept in the transcript as parts
//   !exit                the process ends there (in the TUI: the TUI exits mid-turn, as a killed Claude Code does)
//   !perm <command>      in the TUI: a permission prompt, as Claude Code's (OSC 7501 blocked, kind=permission); "1"
//                        allows ("ran <command>"), Esc denies ("denied <command>")
//   !dialog <title>|<choice>|…  in the TUI: any other dialog, as Claude Code's product prompts (OSC 7501 blocked, "dialog
//                        open"), drawn below a rule with its choices ("❯" at the one selected); arrows move, Enter
//                        chooses ("chose <choice>"), Esc dismisses ("dismissed <title>")
//   !tool <name> <JSON>  a tool call of that name with that input, done ("ok"), kept in the transcript (a TodoWrite, an
//                        update_plan, a Codex plan item as "plan")
//   !ask <name> <JSON>   a tool call that asks the app first, as a harness's permission request does (POST to its
//                        permissionUrl; an ExitPlanMode with { plan }): allowed, its output "approved"; denied, its error
//                        is the app's message; then a block "allowed <name>" or "denied <name>: <message>"
// Its tools are named as Claude Code's are (Bash, Agent, TodoWrite …) or Codex's (update_plan, plan), and say what they
// do by those harnesses' tables (lib/claude-tools.ts, lib/codex-tools.ts).
// Another process holding its session: <stateDir>/holder.json ({ pid, name? }), what its "holder" op then reports.
// A thread session slow to start: <stateDir>/ready-delay (milliseconds) before it says it is ready. A TUI slow to take
// a paste in, or that loses the Enter after one, or slow to start a turn: paste-delay, lose-enter, start-delay (tuiProgram).
// With no !say / !slow / !sh step the reply is "echo: <message>". In the TUI, Esc stops the turn, and a message typed
// while it runs is taken in before its next step (or, typed after the last one, is the next turn).
// A stranger's one-off answer (the "stranger" op, SPEC 13.7): no steps run (it has no tools), nothing is written to a
// session; the reply says what it was asked for: "(one-off, no tools, at most <cap> tokens, as a stranger) echo: <words>".
// Its usage (the "usage" op, and a data-usage chunk at the end of each turn): 1000 tokens of context per message in the
// session, 10 of output per reply, a window of 200k.
// The id its transcript keeps a message under: on a thread, each message's "user" event says it (as Codex's item id
// does); headless and in the TUI it says none, so the engine finds the message by its words (core: agents/ids.ts).
import { exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { UIMessage, UIMessageChunk } from "ai";
import { claudeToolLive } from "../src/lib/claude-tools.ts";
import { codexTool } from "../src/lib/codex-tools.ts";
import { askApp } from "../src/lib/permission.ts";
import { annotate, type Classify } from "../src/lib/tools.ts";
import { byTime, turnsOf, type TrajectoryRecord } from "../src/lib/trajectory.ts";

// tui: the agent's TUI is running, as this pid; session: the TUI's own (it writes to the session it is on).
// thread: the thread the agent's session has open (fake-thread.ts).
// skills, mcps: what the agent declares instead of its harness's own (core: agents/runner.ts, ownConfig).
// appRoot: the app's folder (core: agents/runner.ts, agentInput).
type Input = { op: string; message?: string; cwd: string; stateDir: string; env?: Record<string, string>; tui?: number; session?: string; thread?: string; skills?: string[]; mcps?: Record<string, unknown>; appRoot?: string; systemPrompt?: string; permissionUrl?: string; options?: Record<string, unknown> };
// "end": the TUI finished a turn (what the follow op waits for).
// "parts": parts of the reply other than text (the sub-agents of !agents), as they are shown.
// "queued": a message typed into the TUI while it was in a turn (Claude Code's queue-operation enqueue); it is a
// "user" entry once the turn takes it in.
// kind: a user entry that is no one's message (a compaction's summary), as the history marks it (metadata.kind).
type Entry = { uuid: string; type: "user" | "assistant" | "end" | "title" | "parts" | "queued"; text: string; at: string; parts?: UIMessage["parts"]; kind?: string };
type Where = Pick<Input, "stateDir" | "tui" | "session">;

/** How its turns go, as fake-tui.ts sets it before loading this: null, the runner says nothing (headless). */
const TURNS = ((globalThis as { FAKE_TURNS?: string }).FAKE_TURNS ?? null) as "tui" | "thread" | null;

/** What its calls do: by Claude Code's names, else Codex's. */
const fakeTool: Classify = (name, input, output) => {
  const m = claudeToolLive(name, input, output);
  return m.kind !== "other" ? m : codexTool(name, input, output);
};
const said = annotate(fakeTool);
const out = (c: UIMessageChunk | Record<string, unknown>) => process.stdout.write(JSON.stringify(said(c as Record<string, unknown>)) + "\n");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/**
 * Its sessions are <stateDir>/<id>.jsonl ("transcript" until a /clear in the TUI starts another), and its TUI says which
 * one it is on in <stateDir>/tui-<pid>.json, as Claude Code does in its registry. The session: the TUI's, while it runs,
 * else the folder's latest.
 */
function sessionOf(input: Where): string {
  if (input.session) return input.session;
  const registry = input.tui ? join(input.stateDir, `tui-${input.tui}.json`) : "";
  if (registry && existsSync(registry)) return JSON.parse(readFileSync(registry, "utf8")).session;
  const files = existsSync(input.stateDir) ? readdirSync(input.stateDir).filter((f) => f.endsWith(".jsonl")) : [];
  const latest = files.map((f) => ({ f, t: statSync(join(input.stateDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return latest?.f.replace(/\.jsonl$/, "") ?? "transcript";
}
const transcript = (input: Where) => join(input.stateDir, `${sessionOf(input)}.jsonl`);

function write(input: Where, type: Entry["type"], text: string, parts?: UIMessage["parts"], uuid: string = randomUUID()) {
  mkdirSync(input.stateDir, { recursive: true });
  appendFileSync(transcript(input), JSON.stringify({ uuid, type, text, at: new Date().toISOString(), ...(parts ? { parts } : {}) } satisfies Entry) + "\n");
}

function entries(input: Input): Entry[] {
  if (!existsSync(transcript(input))) return [];
  return readFileSync(transcript(input), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry).filter((e) => e.type === "user" || e.type === "assistant" || e.type === "parts");
}

/**
 * What a turn in the TUI or on a thread has besides its message: stopped (Esc, an interrupt); a message typed while it
 * runs, taken in before its next step (as Claude Code steers one into a turn between tool calls); a permission prompt.
 */
type Ctl = { signal?: AbortSignal; next?: () => string | undefined; ask?: (command: string) => Promise<boolean>; dialog?: (title: string, choices: string[]) => Promise<string | null> };
const stepsOf = (message: string) => message.split("\n").map((l) => l.replace(/^\(from \S+\) /, "").trim());

/**
 * One turn: the message's steps, the reply written to the transcript (and, headless, as chunks). Returns its text. id:
 * the message's in the transcript (a thread says it as the message comes in).
 */
async function turn(input: Where & Pick<Input, "cwd" | "env" | "skills" | "mcps" | "appRoot" | "systemPrompt" | "permissionUrl">, message: string, emit: (c: UIMessageChunk) => void, ctl: Ctl = {}, id?: string): Promise<string> {
  write(input, "user", message, undefined, id);
  const said: string[] = [];
  const say = (text: string) => {
    const id = randomUUID();
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: text });
    emit({ type: "text-end", id });
    write(input, "assistant", text);
    said.push(text);
  };
  let acted = false;
  const steps = stepsOf(message);
  for (let i = 0; i < steps.length && !ctl.signal?.aborted; i++) {
    const typed = ctl.next?.();
    if (typed !== undefined) {
      write(input, "user", typed);
      steps.push(...stepsOf(typed));
    }
    const [, step, arg = ""] = /^!(\w+)\s*([\s\S]*)$/.exec(steps[i]) ?? [];
    if (step === "sleep") await sleep(Number(arg), ctl.signal);
    else if (step === "exit") process.exit(3);
    else if (step === "perm") (acted = true), say(`${(await (ctl.ask?.(arg) ?? true)) ? "ran" : "denied"} ${arg}`);
    else if (step === "dialog") {
      const [title, ...choices] = arg.split("|").map((s) => s.trim());
      const chose = ctl.dialog ? await ctl.dialog(title, choices.length ? choices : ["Yes", "No"]) : (choices[0] ?? "Yes");
      (acted = true), say(chose === null ? `dismissed ${title}` : `chose ${chose}`);
    }
    else if (step === "say") (acted = true), say(arg);
    else if (step === "card") (acted = true), say("```pagent\n" + arg + "\n```");
    else if (step === "title") write(input, "title", arg);
    else if (step === "own") (acted = true), say(JSON.stringify({ skills: input.skills ?? null, mcps: input.mcps ?? null }));
    else if (step === "root") (acted = true), say(input.appRoot ?? "");
    else if (step === "prompt") (acted = true), say(input.systemPrompt ?? "");
    else if (step === "slow") {
      acted = true;
      const [n, ms] = arg.split(/\s+/).map(Number);
      for (let i = 1; i <= n; i++) {
        say(`part ${i} of ${n}.`);
        if (i < n) await sleep(ms);
      }
    } else if (step === "agents") {
      acted = true;
      const [n, ms] = arg.split(/\s+/).map(Number);
      write(input, "parts", "", await subagents(n, ms, emit));
      say(`${n} sub-agents done.`);
    } else if (step === "tool" || step === "ask") {
      acted = true;
      const [, name = "tool", json = "{}"] = /^(\S+)\s*([\s\S]*)$/.exec(arg) ?? [];
      const toolInput = JSON.parse(json || "{}");
      const toolCallId = randomUUID();
      emit({ type: "tool-input-start", toolCallId, toolName: name, dynamic: true });
      emit({ type: "tool-input-available", toolCallId, toolName: name, input: toolInput, dynamic: true });
      let denied: string | null = null;
      if (step === "ask") {
        const res = input.permissionUrl ? await askApp(input.permissionUrl, { tool: name, input: toolInput, meta: fakeTool(name, toolInput) }, ctl.signal).catch(() => ({})) : {};
        const decision = (res as { decision?: { allow: boolean; message?: string } }).decision;
        denied = decision?.allow ? null : String(decision?.message ?? "no decision");
      }
      const part: any = denied === null
        ? { type: "dynamic-tool", toolName: name, toolCallId, state: "output-available", input: toolInput, output: step === "ask" ? "approved" : "ok" }
        : { type: "dynamic-tool", toolName: name, toolCallId, state: "output-error", input: toolInput, errorText: denied };
      emit(denied === null ? { type: "tool-output-available", toolCallId, output: part.output, dynamic: true } : { type: "tool-output-error", toolCallId, errorText: denied, dynamic: true });
      write(input, "parts", "", [part]);
      if (step === "ask") say(denied === null ? `allowed ${name}` : `denied ${name}: ${denied}`);
    } else if (step === "sh") {
      acted = true;
      const toolCallId = randomUUID();
      emit({ type: "tool-input-start", toolCallId, toolName: "Bash", dynamic: true });
      emit({ type: "tool-input-available", toolCallId, toolName: "Bash", input: { command: arg }, dynamic: true });
      const r = await new Promise<string>((resolve) =>
        exec(arg, { cwd: input.cwd, env: { ...process.env, ...input.env }, shell: "/bin/sh" }, (e, stdout, stderr) => resolve(`${stdout}${stderr}${e ? `[exit ${e.code}]` : ""}`.trim())),
      );
      emit({ type: "tool-output-available", toolCallId, output: r, dynamic: true });
      write(input, "parts", "", [{ type: "dynamic-tool", toolName: "Bash", toolCallId, state: "output-available", input: { command: arg }, output: r }]);
      say(r);
    }
  }
  if (ctl.signal?.aborted) write(input, "user", "[Request interrupted by user]"); // what Claude Code writes
  else if (!acted) say(`echo: ${message}`);
  return said.join("\n\n");
}

/**
 * n sub-agents side by side: each one's call, then its info and steps as data chunks while it works (a step every ms),
 * done with a summary. Returns the parts as a message keeps them (what the history shows).
 */
async function subagents(n: number, ms: number, emit: (c: UIMessageChunk) => void): Promise<UIMessage["parts"]> {
  const calls = Array.from({ length: n }, (_, i) => ({ id: `call-${randomUUID().slice(0, 8)}`, i, steps: [] as any[] }));
  const info = (i: number, status: string, steps: number) => ({
    type: "Explore",
    description: `Look at file ${i + 1}`,
    status,
    prompt: `Read file-${i + 1}.ts and say what it exports.`,
    toolUses: steps,
    ...(status === "done" ? { durationMs: 3 * ms, summary: `file-${i + 1}.ts exports thing${i + 1}.` } : {}),
  });
  const data = (c: (typeof calls)[number], status: string) => ({ type: "data-subagent", id: c.id, data: info(c.i, status, c.steps.filter((s) => s.type === "dynamic-tool").length) }) as any;
  const step = (c: (typeof calls)[number], k: number) => ({ type: "data-subagent-step", id: `${c.id}:${k}`, data: { of: c.id, part: c.steps[k] } }) as any;
  for (const c of calls) {
    const input = { description: `Look at file ${c.i + 1}`, subagent_type: "Explore", prompt: `Read file-${c.i + 1}.ts and say what it exports.` };
    emit({ type: "tool-input-start", toolCallId: c.id, toolName: "Agent", dynamic: true });
    emit({ type: "tool-input-available", toolCallId: c.id, toolName: "Agent", input, dynamic: true });
    emit(data(c, "running"));
  }
  for (let k = 0; k < 3; k++) {
    await sleep(ms);
    for (const c of calls) {
      if (k > 0) {
        c.steps[k - 1] = { ...c.steps[k - 1], state: "output-available", output: "export const thing = 1;" };
        emit(step(c, k - 1));
      }
      c.steps[k] = { type: "dynamic-tool", toolName: "Read", toolCallId: `${c.id}-s${k}`, state: "input-available", input: { file_path: `/work/file-${c.i + 1}-${k + 1}.ts` } };
      emit(step(c, k));
      emit(data(c, "running"));
    }
  }
  await sleep(ms);
  const parts: any[] = [];
  for (const c of calls) {
    c.steps[2] = { ...c.steps[2], state: "output-available", output: "export const thing = 1;" };
    c.steps.push({ type: "text", text: `file-${c.i + 1}.ts exports thing${c.i + 1}.`, state: "done" });
    emit(step(c, 2));
    emit(step(c, 3));
    emit(data(c, "done"));
    emit({ type: "tool-output-available", toolCallId: c.id, output: `file-${c.i + 1}.ts exports thing${c.i + 1}.`, dynamic: true });
  }
  for (const c of calls) parts.push({ type: "dynamic-tool", toolName: "Agent", toolCallId: c.id, state: "output-available", input: { description: `Look at file ${c.i + 1}`, subagent_type: "Explore" }, output: `file-${c.i + 1}.ts exports thing${c.i + 1}.` });
  for (const c of calls) parts.push(data(c, "done"), ...c.steps.map((_, k) => step(c, k)));
  return parts;
}

/** The session's usage, made up from its transcript (runners/src/lib/usage.ts has the shape). */
function usageOf(input: Input) {
  const all = entries(input).filter((e) => e.type !== "parts");
  if (!all.length) return null;
  const replies = all.filter((e) => e.type === "assistant").length;
  return { context: all.length * 1000, window: 200_000, input: all.length * 1000, cacheRead: 0, cacheWrite: 0, output: replies * 10, compactions: 0, requests: replies, model: "fake", at: all.at(-1)!.at };
}

/** A stranger's answer: what it was asked for, and the stranger's words (from inside the caller line's <message>). */
function stranger(input: Input & { systemPrompt?: string; maxOutputTokens?: number }) {
  const words = /<message>\n([\s\S]*)\n<\/message>$/.exec(input.message ?? "")?.[1] ?? input.message ?? "";
  const told = /stranger/.test(input.systemPrompt ?? "") && /by a stranger \(no key\)/.test(input.message ?? "");
  const text = `(one-off, no tools, at most ${input.maxOutputTokens} tokens${told ? ", as a stranger" : ""}) echo: ${words}`;
  const id = randomUUID();
  for (const c of [{ type: "start" }, { type: "text-start", id }, { type: "text-delta", id, delta: text }, { type: "text-end", id }]) out(c);
  out({ type: "data-result", data: { text }, transient: true });
  out({ type: "finish" });
}

async function ask(input: Input) {
  out({ type: "data-session", data: { sessionId: "fake" }, transient: true });
  out({ type: "start" });
  out({ type: "start-step" });
  const text = await turn(input, input.message ?? "", out);
  out({ type: "finish-step" });
  out({ type: "data-usage", data: usageOf(input), transient: true });
  out({ type: "data-result", data: { text }, transient: true });
  out({ type: "finish" });
}

/** The transcript as messages: a user line each; the assistant lines after it, one message. <stateDir>/slow-history: it takes that many ms. */
async function history(input: Input) {
  const slow = join(input.stateDir, "slow-history");
  if (existsSync(slow)) await sleep(Number(readFileSync(slow, "utf8")));
  const messages: UIMessage[] = [];
  let assistant: UIMessage | null = null;
  for (const e of entries(input)) {
    if (e.type === "user") {
      messages.push({ id: e.uuid, role: "user", parts: [{ type: "text", text: e.text }], ...(e.kind ? { metadata: { kind: e.kind } } : {}) });
      assistant = null;
    } else {
      if (!assistant) messages.push((assistant = { id: e.uuid, role: "assistant", parts: [{ type: "step-start" }] }));
      if (e.type === "parts") assistant.parts.push(...(e.parts ?? []));
      else assistant.parts.push({ type: "text", text: e.text, state: "done" });
    }
  }
  out({ type: "history", messages, ...(existsSync(transcript(input)) ? { file: transcript(input) } : {}) });
}

/**
 * Its session as a trajectory (runners/src/lib/trajectory.ts): each message a turn; each block of a reply a request,
 * from what came before it to when it was written, with the tokens its usage says (10 of output); a !sh step's call
 * a tool. In the shape the real runners give. <stateDir>/slow-trajectory: it says what it read that many ms after reading
 * it (what is written meanwhile is not in it, as with a long transcript).
 */
async function trajectory(input: Input) {
  const records: TrajectoryRecord[] = [];
  let turn: string | null = null;
  let last = 0;
  const read = entries(input);
  const slow = join(input.stateDir, "slow-trajectory");
  if (existsSync(slow)) await sleep(Number(readFileSync(slow, "utf8")));
  for (const e of read) {
    const at = Date.parse(e.at);
    if (e.type === "user") {
      turn = e.uuid;
      records.push({ id: e.uuid, turnId: turn, kind: "user", start: at, input: e.text });
    } else if (e.type === "assistant") {
      records.push({ id: e.uuid, turnId: turn, kind: "assistant", start: last || at, end: at, name: "stand-in", model: "stand-in", output: e.text, usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 10 } });
    } else {
      for (const p of (e.parts ?? []) as any[]) {
        if (p.type === "dynamic-tool") records.push({ id: p.toolCallId, turnId: turn, kind: "tool", start: last || at, end: at, name: p.toolName, input: p.input, output: p.output });
      }
    }
    last = at;
  }
  const file = existsSync(transcript(input)) ? transcript(input) : null;
  out({ type: "trajectory", records: [...turnsOf(records), ...records].sort(byTime), ...(file ? { file } : {}) });
}

function last(input: Input) {
  const all = entries(input);
  const reply = all.filter((e) => e.type === "assistant").pop();
  const file = existsSync(transcript(input)) ? transcript(input) : null;
  const title = file ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry).filter((e) => e.type === "title").pop()?.text ?? null : null;
  out({ type: "last", text: reply?.text ?? null, at: reply?.at ?? null, lastAt: all.at(-1)?.at ?? null, title, file });
}

// ---------------------------------------------------------------- the TUI (fake-tui.ts)

/**
 * The fake TUI, a program in the agent's terminal: it reports its state the way Claude Code does (OSC 7501), and runs
 * each message pasted into it (then Enter) as a turn, written to the transcript and ended with an "end" entry. It works
 * on the session it was started on; "/clear" starts a new one (an empty transcript), which it registers. Esc stops the
 * turn (or, at a permission prompt, denies; "1" allows). A message pasted during a turn waits ("queued") and is taken
 * into it before its next step; one that comes after the last step is the next turn.
 */
async function tuiProgram(stateDir: string, start: string) {
  const state = (s: string, more = "") => process.stdout.write(`\x1b]7501;state=${s}${more}\x07`);
  let session = start;
  const register = () => writeFileSync(join(stateDir, `tui-${process.pid}.json`), JSON.stringify({ session }));
  mkdirSync(stateDir, { recursive: true });
  register();
  process.stdin.setRawMode?.(true);
  process.stdout.write("fake TUI\r\n");
  state("idle");
  let buf = "";
  let busy = Promise.resolve();
  let current: { stop: AbortController; queue: string[]; prompt?: (allowed: boolean) => void; key?: (k: string) => void } | null = null;
  const run = async (message: string) => {
    const where = { stateDir, session };
    const t: NonNullable<typeof current> = (current = { stop: new AbortController(), queue: [] });
    state("working");
    const ask = (command: string) =>
      new Promise<boolean>((resolve) => {
        t.prompt = resolve;
        state("blocked", `:kind=permission:msg=${Buffer.from(`approve Bash: ${command}`).toString("base64")}`);
      }).then((allowed) => ((t.prompt = undefined), state("working"), allowed));
    // A dialog below a rule, redrawn as the selection moves (the screen cleared first, as a TUI redraws its frame).
    const dialog = (title: string, choices: string[]) =>
      new Promise<string | null>((resolve) => {
        let at = 0;
        const draw = () =>
          process.stdout.write(`\x1b[2J\x1b[H${"─".repeat(40)}\r\n ${title}\r\n\r\n${choices.map((c, i) => ` ${i === at ? "❯" : " "} ${c}`).join("\r\n")}\r\n\r\n ↑/↓ choose · enter confirm · esc not now\r\n`);
        draw();
        state("blocked", `:msg=${Buffer.from("dialog open").toString("base64")}`);
        t.key = (k) => {
          if (k === "\x1b[A" || k === "\x1b[B") return (at = Math.max(0, Math.min(choices.length - 1, at + (k === "\x1b[B" ? 1 : -1)))), draw();
          if (k !== "\r" && k !== "\x1b") return;
          t.key = undefined;
          state("working");
          resolve(k === "\r" ? choices[at] : null);
        };
      });
    const text = await turn({ ...where, cwd: process.cwd(), env: {} }, message, () => {}, { signal: t.stop.signal, next: () => t.queue.shift(), ask, dialog });
    process.stdout.write(`${text.replace(/\n/g, "\r\n")}\r\n`);
    if (!t.stop.signal.aborted) write(where, "end", "");
    current = null;
    state("idle");
    for (const next of t.stop.signal.aborted ? [] : t.queue) await run(next);
  };
  // Its prompt: what was pasted and not sent yet (pasted again, it is added on a line of its own). A paste is taken in
  // at once, and drawn below; with <stateDir>/paste-delay (ms), only after that long, and an Enter meanwhile is lost (as
  // Claude Code may lose one). <stateDir>/lose-enter: how many Enters after a paste it loses anyway (SPEC 13.25: the
  // message stays in its prompt); <stateDir>/start-delay (ms): how long a message it took waits before its turn starts.
  let prompt = "";
  let taking = 0; // pastes still being taken in
  const setting = (name: string) => (existsSync(join(stateDir, name)) ? Number(readFileSync(join(stateDir, name), "utf8")) : 0);
  const take = (text: string) => {
    prompt = prompt ? `${prompt}\n${text}` : text;
    process.stdout.write(`> ${text.replace(/\n/g, "\r\n  ")}\r\n`);
  };
  // Enter sends what its prompt has (an empty one: nothing), unless a paste is still being taken in, or it loses it.
  const enter = (): string | null => {
    if (taking) return null;
    const lose = setting("lose-enter");
    if (prompt && lose > 0) return writeFileSync(join(stateDir, "lose-enter"), String(lose - 1)), null;
    const message = prompt;
    prompt = "";
    return message || null;
  };
  process.stdin.setEncoding("utf8").on("data", (d: string) => {
    if (current?.prompt && (d === "1" || d === "\x1b")) return current.prompt(d === "1");
    if (current?.key) return current.key(d);
    if (d === "\x1b") return void current?.stop.abort();
    buf += d;
    for (let m; (m = /\x1b\[200~([\s\S]*?)\x1b\[201~|\r/.exec(buf)); ) {
      buf = buf.slice(m.index + m[0].length);
      if (m[0] !== "\r") {
        const [text, delay] = [m[1], setting("paste-delay")];
        if (!delay) take(text);
        else taking++, setTimeout(() => (taking--, take(text)), delay);
        continue;
      }
      const message = enter();
      if (message === null) continue;
      if (current) {
        write({ stateDir, session }, "queued", message);
        current.queue.push(message);
        continue;
      }
      busy = busy.then(async () => {
        await sleep(setting("start-delay"));
        if (message.trim() === "/clear") {
          session = `s-${randomUUID().slice(0, 8)}`;
          writeFileSync(join(stateDir, `${session}.jsonl`), "");
          return register();
        }
        await run(message);
      });
    }
  });
}

/**
 * A turn in the TUI, as chunks: "mark" once the transcript's end is noted, then what is written after it, to its end.
 * A message typed meanwhile says "taken" when the turn takes it in; one still waiting at the end keeps the follow going
 * to the end of the turn it starts (the claude runner's follow does the same).
 */
async function follow(input: Input) {
  const file = transcript(input);
  let offset = existsSync(file) ? statSync(file).size : 0;
  out({ type: "mark" });
  out({ type: "start" });
  let said: string[] = [];
  const waiting: string[] = [];
  let rest = "";
  for (;;) {
    await sleep(100);
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size <= offset) continue;
    const fd = openSync(file, "r");
    const bytes = Buffer.alloc(size - offset);
    readSync(fd, bytes, 0, bytes.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (rest + bytes.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line) as Entry;
      if (e.type === "assistant") {
        const id = randomUUID();
        for (const c of [{ type: "text-start", id }, { type: "text-delta", id, delta: e.text }, { type: "text-end", id }]) out(c);
        said.push(e.text);
      } else if (e.type === "queued") waiting.push(e.text);
      else if (e.type === "user" && waiting.includes(e.text)) {
        waiting.splice(waiting.indexOf(e.text), 1);
        out({ type: "taken", text: e.text });
      } else if (e.type === "end" && waiting.length) said = [];
      else if (e.type === "end") {
        out({ type: "data-usage", data: usageOf(input), transient: true });
        out({ type: "data-result", data: { text: said.join("\n\n") }, transient: true });
        return out({ type: "finish" });
      }
    }
  }
}

// ---------------------------------------------------------------- a shared thread (fake-thread.ts)

/**
 * The service the threads live on (as Codex's app-server): here it only writes down where it runs and with what
 * environment (<PAGENT_HOME>/fake-service.json), and stays up.
 */
function serviceProgram(file: string) {
  writeFileSync(file, JSON.stringify({ cwd: process.cwd(), env: process.env }));
  setInterval(() => {}, 1 << 30);
}

const home = () => process.env.PAGENT_HOME ?? tmpdir();

/**
 * The service, as the runner describes it: where it runs, and what of the environment it must not get. FAKE_SERVICE_BIN
 * (a program that runs node): run by it, one service per version of it, as the codex runner's app-server.
 */
function service() {
  const cwd = join(home(), "fake-service");
  mkdirSync(cwd, { recursive: true });
  const bin = process.env.FAKE_SERVICE_BIN;
  const version = bin ? `:${createHash("sha1").update(`${realpathSync(bin)}\t${statSync(bin).mtimeMs}`).digest("hex").slice(0, 6)}` : "";
  out({ type: "service", id: `fake-service:${home()}${version}`, command: bin ?? process.execPath, args: [fileURLToPath(import.meta.url), "--service", join(home(), "fake-service.json")], envDrop: ["FAKE_DROP_"], cwd });
}

/**
 * The agent's session: a long-lived client of its thread (the folder's latest transcript, or a new one), as the codex
 * runner's. Each "ask" starts a turn, or joins the one in progress (steered: the turn answers both); so does a message
 * typed into the thread's TUI (threadTui, which appends it to <stateDir>/<thread>.typed). It reports what it does as
 * the codex runner does: ready, then per turn "turn", "user" for each message, its chunks, "turn-end". "interrupt"
 * stops the turn in progress (its end says "interrupted").
 */
async function sessionProgram(input: Input, commands: AsyncIterator<string>) {
  const thread = sessionOf(input);
  const where = { stateDir: input.stateDir, session: thread, cwd: input.cwd, env: input.env, skills: input.skills, mcps: input.mcps, permissionUrl: input.permissionUrl };
  let current = null as { id: string; lines: string[]; queue: { text: string; id: string }[]; said: string; stop: AbortController } | null;
  const emit = (o: Record<string, unknown>) => {
    const line = JSON.stringify(said(o));
    current?.lines.push(line);
    process.stdout.write(line + "\n");
  };
  // Each message says the id the thread keeps it under (as Codex's item id), which its history has it under.
  const message = (text: string, clientId: string | null, meta?: unknown) => {
    const id = randomUUID();
    if (current) {
      emit({ type: "user", turnId: current.id, id, text, clientId, meta });
      current.queue.push({ text, id });
      return;
    }
    const t = (current = { id: randomUUID(), lines: [], queue: [{ text, id }], said: "", stop: new AbortController() });
    emit({ type: "turn", turnId: t.id });
    emit({ type: "user", turnId: t.id, id, text, clientId, meta });
    void (async () => {
      for (let next; !t.stop.signal.aborted && (next = t.queue.shift()) !== undefined; ) t.said = (await turn(where, next.text, emit, { signal: t.stop.signal }, next.id)) || t.said;
      emit({ type: "turn-end", turnId: t.id, status: t.stop.signal.aborted ? "interrupted" : "completed", text: t.said });
      current = null;
    })();
  };
  const delay = join(input.stateDir, "ready-delay");
  if (existsSync(delay)) await new Promise((r) => setTimeout(r, Number(readFileSync(delay, "utf8"))));
  out({ type: "ready", threadId: thread });

  // What the thread's TUI sends: one JSON line each in <stateDir>/<thread>.typed.
  const typed = join(input.stateDir, `${thread}.typed`);
  let offset = existsSync(typed) ? statSync(typed).size : 0;
  setInterval(() => {
    const size = existsSync(typed) ? statSync(typed).size : 0;
    if (size <= offset) return;
    const fd = openSync(typed, "r");
    const bytes = Buffer.alloc(size - offset);
    readSync(fd, bytes, 0, bytes.length, offset);
    closeSync(fd);
    offset = size;
    for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) message(JSON.parse(line).text, null);
  }, 100).unref();

  for (;;) {
    const next = await commands.next();
    if (next.done) break; // the daemon closed stdin: it is going away
    let c: any;
    try {
      c = JSON.parse(next.value);
    } catch {
      continue;
    }
    if (c.op === "ask") message(String(c.message ?? ""), c.run, c.meta);
    else if (c.op === "state") {
      out({ type: "ready", threadId: thread });
      for (const line of current?.lines ?? []) process.stdout.write(line + "\n");
    } else if (c.op === "interrupt") current?.stop.abort();
    else if (c.op === "stop") break;
  }
  process.stdout.write("", () => process.exit(0));
}

/** The thread's TUI, one more client of it: each message pasted into it (then Enter) goes to the thread. No status. */
function threadTui(stateDir: string, thread: string) {
  process.stdin.setRawMode?.(true);
  mkdirSync(stateDir, { recursive: true });
  process.stdout.write("fake thread TUI\r\n");
  let buf = "";
  process.stdin.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let m; (m = /\x1b\[200~([\s\S]*?)\x1b\[201~\r/.exec(buf)); ) {
      buf = buf.slice(m.index + m[0].length);
      appendFileSync(join(stateDir, `${thread}.typed`), JSON.stringify({ text: m[1] }) + "\n");
    }
  });
}

/**
 * Another process that has the session open, as Claude Code's registry would say: a test writes <stateDir>/holder.json
 * ({ pid, name? }) to play one, and removes it to let go.
 */
function holderOf({ stateDir }: Input): { pid: number; name?: string } | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "holder.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main

if (process.argv[2] === "--tui") await tuiProgram(process.argv[3], process.argv[4] ?? "transcript");
else if (process.argv[2] === "--thread-tui") threadTui(process.argv[3], process.argv[4]);
else if (process.argv[2] === "--service") serviceProgram(process.argv[3]);
else {
  // The first line is the input; a session keeps reading commands from the lines after it.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  const input = JSON.parse(first.done ? "{}" : first.value) as Input;
  if (input.thread) input.session = input.thread; // its quick ops read the thread the session has open
  const self = fileURLToPath(import.meta.url);
  if (input.op === "ask") await ask(input);
  else if (input.op === "history") await history(input);
  else if (input.op === "last") last(input);
  else if (input.op === "trajectory") await trajectory(input);
  else if (input.op === "usage") out({ type: "usage", usage: usageOf(input), file: existsSync(transcript(input)) ? transcript(input) : null });
  else if (input.op === "info") out({ type: "info", sessionId: sessionOf(input), resume: null });
  else if (input.op === "holder") out({ type: "holder", holder: holderOf(input), choices: [] });
  // It answers strangers. A message during a turn goes into it in its TUI and on its thread, not headless.
  else if (input.op === "describe") {
    const ops = ["last", "info", "usage", "trajectory", "holder", "move", "stranger", "interactive", ...(TURNS === "thread" ? ["service"] : [])];
    out({ type: "describe", harness: { id: "fake", title: "Fake" }, turns: TURNS ?? "headless", ops, interject: TURNS !== null });
  }
  else if (input.op === "stranger") stranger(input);
  else if (input.op === "move") out({ type: "moved", sessions: 0 }); // its sessions are in its state, which moved with the folder
  // An agent declared with `asks: "<question>"`: its TUI never comes up, a question waits on its screen first (as a
  // shell's rc can ask before the CLI starts: "[oh-my-zsh] Would you like to update? [Y/n]").
  else if (input.op === "interactive" && TURNS === "tui" && typeof input.options?.asks === "string") out({ type: "command", command: "/bin/sh", args: ["-c", `printf "%s " "$0"; read answer`, input.options.asks], cwd: input.cwd });
  // `bin`: a program that runs node, run instead (a test updates it).
  else if (input.op === "interactive" && TURNS === "tui") out({ type: "command", command: typeof input.options?.bin === "string" ? input.options.bin : process.execPath, args: [self, "--tui", input.stateDir, sessionOf(input)], cwd: input.cwd, env: input.env, keys: { interrupt: ["\x1b"], allow: ["1"], deny: ["\x1b"] }, prompt: String.raw`^approve (\S+?):\s*([\s\S]*)$` });
  else if (input.op === "interactive" && TURNS === "thread") out({ type: "command", command: process.execPath, args: [self, "--thread-tui", input.stateDir, sessionOf(input)], cwd: input.cwd, env: input.env });
  else if (input.op === "interactive") out({ type: "command", command: "/bin/cat", args: [], cwd: input.cwd });
  else if (input.op === "follow" && TURNS === "tui") await follow(input);
  else if (input.op === "service" && TURNS === "thread") service();
  else if (input.op === "session" && TURNS === "thread") await sessionProgram(input, lines);
  else out({ type: "error", errorText: `the fake runner has no op ${input.op}` });
}
