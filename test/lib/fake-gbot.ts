#!/usr/bin/env node
// A stand-in for gbot (grok-bot-cli 0.12.4), for runner:grokbot's tests (GBOT_BIN): the commands the runner uses, with
// the JSON gbot prints for them, against a pretend Grok Bot whose state is a folder (FAKE_GBOT_DIR). No account, no
// network. Every call is logged (calls.jsonl), so a test sees what the runner did. Its thread's entries have the shape
// the real one's had (live check, 2026-10-20): { kind, id, message: { type, content } | role + content, timestampMs,
// requestId, seq }, a message to the bot kind "message", role "user", isStreaming false (with gbot's [gbot …] head); and
// `send` says no messageId (delivery "unknown"), as it did.
//
// The bot answers by a script in the message, its lines (after gbot's [gbot …] head and pagent's "(from …)" head):
//   !say <text>             a message, a moment after the one before
//   !wait <ms>              the next comes this much later
//   !step <name> <json>     a step (a tool-call entry, with its output; the real thread showed none)
//   !approve <command>      an approval card (auto-review); the rest waits for `approvals respond` (declined: it says so)
//   !local <action> <tgt>   the same, a local-tool-permission card
//   !later <ms> <text>      a schedule (an automation-changed event), and after the rest its message (another request)
//   !stream <words>         a message written a word at a time (isStreaming while it is)
// No script: "Grok heard: <the message's first line>". FAKE_GBOT_DIR/failure (no-session, v3, asleep, waking) breaks it
// the ways the real one breaks (grok-bot-cli #147, #143; a gateway that refuses; one that wakes slowly). A message sent
// without a correlation id has no [gbot …] head: as one written to the bot elsewhere (gbot by hand, Grok Bot's app).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_GBOT_DIR ?? join(process.cwd(), ".fake-gbot");
mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify(argv) + "\n");

type Entry = Record<string, any> & { id: string; at: number };
type State = { seq: number; bots: { id: string; name: string; kind: "bot" }[]; entries: Record<string, Entry[]>; waiting: Record<string, { bot: string; requestId: string; rest: string[] }> };

// ---- the arguments, as gbot's parser takes them (after "--": all words)
const VALUED = new Set(["--correlation-id", "--reply-to", "--limit", "--target", "--entry-id", "--request-id", "--decision", "--name", "--description", "--title", "--hop", "--after", "--dir", "--root"]);
const words: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    words.push(...argv.slice(i + 1));
    break;
  }
  if (a.startsWith("--")) flags[a] = VALUED.has(a) ? argv[++i] : true;
  else words.push(a);
}

const print = (v: unknown, code = 0) => {
  process.stdout.write(JSON.stringify(v) + "\n");
  process.exit(code);
};
const fail = (message: string) => (words[0] === "send" ? print({ delivery: "rejected", error: message, exitCode: 1, reason: "usage" }, 1) : print({ error: { code: "render-failed", message } }, 1));

// ---- the state, under a lock (the runner's session and its quick ops call at once)
const file = join(dir, "state.json");
const lock = join(dir, "lock");
function locked<T>(f: (s: State) => T): T {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 400) rmdirSync(lock); // a holder that died
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  let r: T;
  try {
    const s: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { seq: 0, bots: [{ id: "bot-researcher", name: "Researcher", kind: "bot" }], entries: {}, waiting: {} };
    r = f(s);
    writeFileSync(file + ".tmp", JSON.stringify(s));
    renameSync(file + ".tmp", file);
  } catch (e) {
    rmdirSync(lock);
    return fail((e as Error).message) as never;
  }
  rmdirSync(lock);
  return r;
}

const failure = existsSync(join(dir, "failure")) ? readFileSync(join(dir, "failure"), "utf8").trim() : "";
const NO_DIR = "Could not find a Grok Bot agents directory. Pass --dir or set GROK_BOT_AGENTS_DIR.\nThe macOS app keeps the live roster on its cloud computer (agent-data/agents), not in ~/Library/Application Support/Grok Bot.";

if (argv.includes("--version")) print("0.12.4");
if (words[0] === "doctor") {
  const session = failure === "no-session" ? { present: false, usable: false } : failure === "v3" ? { present: true, usable: false, code: "UNSUPPORTED_VERSION", error: "Unsupported Grok Bot gateway descriptor version 3." } : { present: true, usable: true };
  print({ candidates: [], found: [], gatewayAuthPresent: failure !== "no-session", grokBotAppSession: session, note: "Live roster is on the box.", resolved: null });
}
// The Cursor login's way in (CURSOR_ACCESS_TOKEN), taken as gbot takes it: only when there is no app session (gbot
// prefers the app's; it is in HOME's Application Support). Refused without the app's version; else it reaches the
// computer, waking it (an "asleep" failure is gone after), and needs no descriptor. "waking": asleep, and the first
// call that wakes it times out while it starts, as the real one's did (the next one finds it up).
const appSession = existsSync(join(process.env.HOME ?? "", "Library/Application Support/Grok Bot"));
const cursor = !!process.env.CURSOR_ACCESS_TOKEN && !appSession && words[0] !== "doctor";
if (cursor && !process.env.SAND_CLIENT_VERSION) fail("EnsureSandBox failed: 401 This version of Grok Bot is no longer supported. Update Grok Bot from cursor.com/sand to continue.");
if (cursor && failure === "waking") {
  writeFileSync(join(dir, "failure"), "asleep");
  fail(`${words[0] === "thread" ? "getAgentTranscriptTail" : "listAgents"} failed: 500 [deadline_exceeded] the operation timed out`);
}
if (cursor && failure === "asleep") rmSync(join(dir, "failure"));
if (!cursor && failure === "no-session") fail(NO_DIR);
if (!cursor && failure === "v3") fail("Unsupported Grok Bot gateway descriptor version 3.");
if (!cursor && (failure === "asleep" || failure === "waking")) fail("listAgents failed: 417 Expectation Failed");

const summary = (b: State["bots"][number]) => ({ id: b.id, name: b.name, kind: b.kind });
const find = (s: State, ref: string) => {
  const r = ref.trim().toLowerCase();
  return s.bots.find((b) => b.id.toLowerCase() === r) ?? s.bots.find((b) => b.name.toLowerCase() === r);
};
const target = (s: State, ref: string) => {
  const b = find(s, ref);
  if (!b) throw new Error(`No bot or group named "${ref}"`);
  return b;
};
const now = () => Date.now();

/** The bot's entries for a script's lines, from `at` on; what waits for an approval is kept. */
function play(s: State, bot: string, requestId: string, lines: string[], at: number) {
  const list = (s.entries[bot] ??= []);
  const add = (e: Omit<Entry, "id" | "at">, when: number) => list.push({ kind: e.kind, id: `e-${++s.seq}`, ...e, timestampMs: when, seq: s.seq, at: when } as Entry);
  let t = at;
  const later: [number, string][] = [];
  for (let i = 0; i < lines.length; i++) {
    const [cmd, ...rest] = lines[i].split(" ");
    const arg = rest.join(" ");
    if (cmd === "!wait") t += Number(arg) || 0;
    else if (cmd === "!say") add({ kind: "send-message", requestId, message: { type: "text", content: arg } }, (t += 100));
    else if (cmd === "!step") {
      const [name, ...json] = rest;
      add({ kind: "tool-call", requestId, name, input: JSON.parse(json.join(" ") || "{}"), output: `${name}: done` }, (t += 100));
    } else if (cmd === "!approve" || cmd === "!local") {
      const ask = { requestId: `ap-${s.seq + 1}`, status: "pending", ...(cmd === "!approve" ? { command: arg, reason: "publishing needs your OK" } : { action: rest[0], target: rest.slice(1).join(" "), machineId: "box" }) };
      add({ kind: "send-message", requestId, message: cmd === "!approve" ? { type: "auto-review-approval", approval: ask } : { type: "local-tool-permission", ask } }, (t += 100));
      s.waiting[list.at(-1)!.id] = { bot, requestId, rest: lines.slice(i + 1) };
      return;
    } else if (cmd === "!later") later.push([Number(rest[0]) || 0, rest.slice(1).join(" ")]);
    else if (cmd === "!stream") {
      add({ kind: "message", role: "assistant", requestId, chunks: rest, every: 150, content: "", isStreaming: true }, (t += 100));
      t += 150 * rest.length;
    }
  }
  for (const [ms, text] of later) {
    // As the real one: the schedule it makes is an event (no requestId), its message later another request.
    add({ kind: "event", event: { type: "automation-changed", action: "created", automationId: `later-${s.seq + 1}`, automationName: `later-${s.seq + 1}` } }, (t += 50));
    add({ kind: "send-message", requestId: `sched-${s.seq + 1}`, message: { type: "text", content: text } }, t + ms);
  }
}

const [cmd, sub] = words;
if (cmd === "bots" && sub === "get") print(locked((s) => summary(target(s, words[2]))));
if (cmd === "bots" && sub === "list") print(locked((s) => s.bots.map(summary)));
if (cmd === "bots" && sub === "create")
  print(
    locked((s) => {
      const b = { id: `bot-${++s.seq}`, name: String(flags["--name"]), kind: "bot" as const };
      s.bots.push(b);
      return summary(b);
    }),
  );

if (cmd === "send") {
  print(locked((s) => {
    const b = target(s, words[1]);
    const corr = typeof flags["--correlation-id"] === "string" ? flags["--correlation-id"] : undefined;
    const message = words.slice(2).join(" ").trim();
    const head = corr ? `[gbot msg=m${s.seq} corr=${corr} hop=0 from=test@fake]\n` : "";
    const requestId = `req-${++s.seq}`;
    const id = `u-${s.seq}`;
    (s.entries[b.id] ??= []).push({ kind: "message", id, role: "user", content: head + message, isStreaming: false, timestampMs: now(), clientNonce: `n-${s.seq}`, requestId, seq: s.seq, at: now() });
    const lines = message.replace(/^\(from [^)]*\) /, "").split("\n"); // pagent's "(from …)" head
    const script = lines.filter((l) => l.startsWith("!"));
    play(s, b.id, requestId, script.length ? script : [`!say Grok heard: ${lines[0]}`], now());
    return { id: b.id, name: b.name, kind: "bot", result: {}, delivery: "unknown", envelopeId: `m${s.seq}`, correlationId: corr ?? `m${s.seq}`, hop: 0, maxHops: 4, exitCode: 0 }; // as the real one: no messageId
  }));
}

// What the thread shows now: what is due; a message being written (!stream) as far as it got, isStreaming until it ends.
const visible = (s: State, bot: string) =>
  (s.entries[bot] ?? [])
    .filter((e) => e.at <= now())
    .sort((a, b) => a.at - b.at)
    .map(({ at: _, chunks, every, ...e }) => {
      if (!chunks) return e;
      const n = Math.min(chunks.length, 1 + Math.floor((now() - _) / every));
      return { ...e, content: chunks.slice(0, n).join(" "), isStreaming: n < chunks.length };
    });

if (cmd === "thread") {
  print(locked((s) => {
    const b = target(s, words[1]);
    const limit = Math.min(200, Number(flags["--limit"] ?? 40));
    return { target: { id: b.id, name: b.name, title: "", description: "", avatarShape: "", avatarColor: "", isGroup: false, memberIds: [] }, transcript: { entries: visible(s, b.id).slice(-limit) } };
  }));
}

if (cmd === "approvals" && sub === "list") {
  print(locked((s) => {
    const b = target(s, words[2]);
    const approvals = visible(s, b.id).flatMap((e: any) => {
      const card = e.message?.approval ?? e.message?.ask;
      return card?.status === "pending" ? [{ entryId: e.id, requestId: card.requestId, type: e.message.type, ...card, truncated: false }] : [];
    });
    return { target: { id: b.id, name: b.name }, approvals, coverage: "Latest 200 transcript entries only; older requests require the owning Grok UI." };
  }));
}

if (cmd === "approvals" && sub === "respond") {
  print(locked((s) => {
    const b = target(s, String(flags["--target"]));
    const e: any = (s.entries[b.id] ?? []).find((x) => x.id === flags["--entry-id"]);
    const card = e?.message?.approval ?? e?.message?.ask;
    if (!card || card.status !== "pending" || card.requestId !== flags["--request-id"]) throw new Error("Stale, foreign or unsupported Grok approval; refresh pending requests or use the owning Grok UI");
    const accept = flags["--decision"] === "accept";
    card.status = accept ? "approved" : "denied";
    const w = s.waiting[e.id];
    delete s.waiting[e.id];
    if (w) play(s, w.bot, w.requestId, accept ? w.rest : ["!say Okay, I won't do that."], now());
    return { target: { id: b.id, name: b.name }, entryId: e.id, requestId: card.requestId, decision: flags["--decision"], delivery: "accepted" };
  }));
}

if (cmd === "history") print([]);
print(`Unknown command: ${words.join(" ")}.`, 1);
