// The runner contract (runners/src/lib/contract.ts, SPEC 13.18), checked the same way on every runner: the engine's
// (each on a recording of its real harness, or a stand-in for it: no model, no network, no account) and the fake ones.
// A new harness is a new runner, and a new case here that is green: every engine runner must have one.
//   describe     its harness (id: its file's name, a title), how its turns go, the optional ops it answers
//   a turn       through ask (one process) or its session (thread runners): well-formed chunks, every tool call saying
//                what it does (toolMetadata, a ToolKind), the answer at its end, its token use in shape
//   permission   what its harness asks before a tool runs reaches the app as a PermissionRequest ({ tool, input, meta })
//   history      the conversation in shape: messages, tool parts with toolMetadata
//   its ops      each optional op it lists answers with what the contract says (last, info, usage, trajectory, …)
// Cases: fake (headless), fake-tui, fake-thread; claude (Claude Code 2.1.302's transcripts; a stand-in `claude -p`);
// codex (codex-cli 0.163.0's rollouts; a stand-in app-server for the ops that ask it); opencode, gemini, qwen (their
// real ACP conversations, recorded by scripts/record-acp.ts, replayed by test/lib/acp-replay.ts); grokbot (a stand-in
// gbot, test/lib/fake-gbot.ts, with the JSON grok-bot-cli 0.12.4 prints).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { OPS, requiredOps, type Describe, type Op } from "../../packages/runners/src/lib/contract.ts";
import { TOOL_KINDS } from "../../packages/runners/src/lib/tools.ts";
import { fakeClaude } from "../lib/claude.ts";
import { standInAppServer } from "../lib/codex-appserver.ts";
import { fakeRunner, fakeThreadRunner, fakeTuiRunner, repo } from "../lib/app.ts";

const src = (name: string) => join(repo, "packages/runners/src", `${name}.ts`);
const replay = join(repo, "test/lib/acp-replay.ts");
const fixtures = join(repo, "test/fixtures");

/** input: what the quick ops get besides (an adopted session); turnInput: what a turn gets instead, when it differs. */
type Setup = { cwd: string; stateDir: string; env: Record<string, string>; input?: Record<string, unknown>; turnInput?: Record<string, unknown>; close?: () => void };
type Case = {
  name: string;
  script: string;
  /** Its harness's id (the engine's runners: the file's name). */
  id: string;
  setup(dir: string): Setup | Promise<Setup>;
  /**
   * A turn to run, and what it must answer (a regular expression); none: its turns need the real harness. then: more
   * messages after it, each a turn of its own (a recording's), the answer the last one's.
   */
  turn?: { message: string; answer: RegExp; asks?: boolean; then?: string[] };
  /** What its history must have, after the turn (or of its recording). */
  history: { user: RegExp; tools?: boolean };
  /** Its permission hook, for a harness that asks through one (claude). */
  hook?: true;
};

const sh = `!sh echo conformance\n!tool TodoWrite {"todos":[{"content":"Read it","status":"completed","activeForm":"Reading"},{"content":"Fix it","status":"in_progress","activeForm":"Fixing"}]}\n!ask Bash {"command":"make"}`;
const fake = (name: string, script: string): Case => ({
  name,
  id: "fake",
  script,
  setup: (dir) => ({ cwd: dir, stateDir: join(dir, "state"), env: {} }),
  turn: { message: sh, answer: /allowed Bash/, asks: true },
  history: { user: /echo conformance/, tools: true },
});
const acp = (id: string, bin: string): Case => ({
  name: id,
  id,
  script: src(id),
  setup: (dir) => ({ cwd: dir, stateDir: join(dir, "state"), env: { [bin]: replay, ACP_FIXTURE: join(fixtures, "acp", `${id}.json`) } }),
  // The recording's: a greeting, then a command, a list of steps and a file written.
  turn: { message: "hello Ada", then: ["(the recording's second message)"], answer: /summary/ },
  history: { user: /hello Ada/, tools: true },
});

const cases: Case[] = [
  fake("fake", fakeRunner),
  fake("fake-tui", fakeTuiRunner),
  fake("fake-thread", fakeThreadRunner),
  {
    name: "claude",
    id: "claude",
    script: src("claude"),
    setup: (dir) => {
      const config = join(dir, "claude");
      cpSync(join(fixtures, "trajectory/claude"), join(config, "projects"), { recursive: true });
      // Turns: a stand-in `claude -p` (test/lib/claude.ts); the history and the rest: the recorded session, adopted.
      return { cwd: dir, stateDir: join(dir, "state"), env: { CLAUDE_CONFIG_DIR: config, CLAUDE_BIN: fakeClaude(dir) }, input: { seedSession: "3819bbb2-b7eb-428a-8a15-e3c735ac27e4" }, turnInput: {} };
    },
    // The stand-in answers how it found the session: the folder's (--continue), a new one.
    turn: { message: "hello Ada", answer: /^continue / },
    history: { user: /SCENARIO:tools please write the notes/, tools: true },
    hook: true,
  },
  {
    name: "codex",
    id: "codex",
    script: src("codex"),
    setup: async (dir) => {
      const codexHome = join(dir, "codex");
      cpSync(join(fixtures, "trajectory/codex"), codexHome, { recursive: true });
      const home = join(dir, "pagent");
      mkdirSync(home, { recursive: true });
      const server = await standInAppServer(codexHome, home);
      return { cwd: "/Users/sam/code/lisbon", stateDir: join(dir, "state"), env: { CODEX_HOME: codexHome, PAGENT_HOME: home }, input: { seedSession: "01a14d6e-843d-7f02-ac5e-a2c858a0f8a1", thread: "01a14d6e-843d-7f02-ac5e-a2c858a0f8a1" }, close: () => server.close() };
    },
    // Its turns run on Codex's own app-server (a thread): no recording of one here (the smoke tests' fake thread runner).
    history: { user: /SCENARIO:tools write the notes/, tools: true },
  },
  acp("opencode", "OPENCODE_BIN"),
  acp("gemini", "GEMINI_BIN"),
  acp("qwen", "QWEN_BIN"),
  {
    name: "grokbot",
    id: "grokbot",
    script: src("grokbot"),
    // A stand-in gbot (test/lib/fake-gbot.ts): its pretend bot answers by the script in the message.
    setup: (dir) => ({
      cwd: dir,
      stateDir: join(dir, "state"),
      env: { GBOT_BIN: join(repo, "test/lib/fake-gbot.ts"), FAKE_GBOT_DIR: join(dir, "gbot"), GROKBOT_POLL_MS: "50", GROKBOT_QUIET_MS: "400", GROKBOT_IDLE_MS: "200", PAGENT_HOME: join(dir, "pagent-home") },
      input: { options: { bot: "Researcher" } },
    }),
    turn: { message: '!step x_search {"query":"lisbon trams"}\n!approve npm publish\n!say a summary of 3 posts', answer: /^a summary of 3 posts$/, asks: true },
    history: { user: /lisbon trams/, tools: true },
  },
];

// ---------------------------------------------------------------- what the contract says, checked

const kinds = new Set<string>(TOOL_KINDS);
function checkMeta(m: any, where: string) {
  assert.ok(m && typeof m === "object", `${where}: a tool call without toolMetadata`);
  assert.ok(kinds.has(m.kind), `${where}: toolMetadata.kind "${m.kind}" is no ToolKind`);
  if (m.steps) assert.ok("set" in m.steps || "add" in m.steps || "update" in m.steps, `${where}: steps is set, add or update`);
  if (m.kind === "proposal") assert.equal(typeof m.plan, "string", `${where}: a proposal has its plan`);
}

function checkChunks(chunks: any[], where: string) {
  const open = new Map<string, string>();
  for (const c of chunks) {
    assert.equal(typeof c.type, "string", `${where}: a chunk without a type`);
    if (/^(text|reasoning)-start$/.test(c.type)) open.set(c.id, c.type.split("-")[0]);
    if (/^(text|reasoning)-delta$/.test(c.type)) assert.equal(open.get(c.id), c.type.split("-")[0], `${where}: a ${c.type} before its start`);
    if (/^(text|reasoning)-end$/.test(c.type)) assert.ok(open.delete(c.id), `${where}: a ${c.type} of nothing open`);
    if (c.type === "tool-input-start" || c.type === "tool-input-available") {
      assert.equal(typeof c.toolCallId, "string");
      assert.equal(typeof c.toolName, "string");
      checkMeta(c.toolMetadata, `${where} ${c.toolName}`);
    }
    if (c.type === "data-usage" && c.data) checkUsage(c.data, where);
    if (c.type === "data-user") assert.equal(typeof c.data?.id, "string", `${where}: data-user says an id`);
  }
}

function checkUsage(u: any, where: string) {
  for (const k of ["context", "input", "cacheRead", "cacheWrite", "output", "compactions"]) assert.equal(typeof u[k], "number", `${where}: usage.${k}`);
  assert.ok(u.window === null || typeof u.window === "number", `${where}: usage.window`);
}

function checkHistory(messages: any[], c: Case) {
  assert.ok(Array.isArray(messages) && messages.length, `${c.name}: a history`);
  let tools = 0;
  for (const m of messages) {
    assert.ok(m.role === "user" || m.role === "assistant", `${c.name}: a message's role`);
    assert.equal(typeof m.id, "string");
    for (const p of m.parts) {
      if (p.type === "dynamic-tool") (tools++, checkMeta(p.toolMetadata, `${c.name} history ${p.toolName}`));
      if (p.type === "data-subagent-step" && p.data?.part?.type === "dynamic-tool") checkMeta(p.data.part.toolMetadata, `${c.name} sub-agent ${p.data.part.toolName}`);
    }
  }
  assert.ok(messages.some((m) => m.role === "user" && c.history.user.test(m.parts.map((p: any) => p.text ?? "").join(""))), `${c.name}: the history has the message`);
  if (c.history.tools) assert.ok(tools > 0, `${c.name}: the history has tool calls`);
}

function checkRecords(records: any[], where: string) {
  const known = new Set(["turn", "user", "assistant", "tool", "subagent", "compaction", "wait"]);
  for (const r of records) {
    assert.ok(known.has(r.kind), `${where}: record kind ${r.kind}`);
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.start, "number", `${where}: a record's start`);
    if (r.end !== undefined) assert.ok(r.end >= r.start - 1, `${where}: a record ends before it starts`);
  }
}

// ---------------------------------------------------------------- running a runner

const env0 = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|OPENAI|GEMINI|ANTHROPIC|GOOGLE|QWEN|OPENCODE|PAGENT_)/.test(k))) as Record<string, string>;

/** One op, its events. Never spawnSync: a stand-in it talks to (the app's end, Codex's app-server) is in this process. */
function op(c: Case, s: Setup, input: Record<string, unknown>): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [c.script], { cwd: s.cwd.startsWith("/Users/sam") ? undefined : s.cwd, env: { ...env0(), ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(JSON.stringify({ cwd: s.cwd, stateDir: s.stateDir, ...s.input, ...input }));
  });
}

/** The app's end of permission requests: each one, allowed. */
async function appEnd(): Promise<{ url: string; asked: any[]; server: Server }> {
  const asked: any[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      asked.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision: { allow: true } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/permission`, asked, server };
}

/** A turn through ask: its chunks, as the process wrote them. */
function askTurn(c: Case, s: Setup, message: string, permissionUrl: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [c.script], { cwd: s.cwd, env: { ...env0(), ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.on("error", reject);
    child.stdin.end(JSON.stringify({ op: "ask", message, cwd: s.cwd, stateDir: s.stateDir, permissionUrl, env: {}, ...(s.turnInput ?? s.input) }));
  });
}

/** A turn through the runner's session (as the daemon runs it): its events from "turn" to "turn-end", and the session's id. */
function sessionTurn(c: Case, s: Setup, messages: string[], permissionUrl: string): Promise<{ events: any[]; thread: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [c.script], { cwd: s.cwd, env: { ...env0(), ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.write(JSON.stringify({ op: "session", cwd: s.cwd, stateDir: s.stateDir, permissionUrl, env: {}, systemPrompt: "You are the agent of the page /lisbon of a pagent app.", ...(s.turnInput ?? s.input) }) + "\n");
    const events: any[] = [];
    let thread = "";
    let buf = "";
    const timer = setTimeout(() => (child.kill(), reject(new Error(`${c.name}: no turn-end in 60 s (${JSON.stringify(events.at(-1))})`))), 60_000);
    child.stdout.setEncoding("utf8").on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const e = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        events.push(e);
        if (e.type === "failed") (clearTimeout(timer), reject(new Error(e.errorText)));
        const ask = (n: number) => child.stdin.write(JSON.stringify({ op: "ask", run: `run-${n + 1}`, message: messages[n] }) + "\n");
        if (e.type === "ready" && !thread) (thread = e.threadId), ask(0);
        const ended = events.filter((x) => x.type === "turn-end").length;
        if (e.type === "turn-end" && ended < messages.length) ask(ended);
        else if (e.type === "turn-end") {
          clearTimeout(timer);
          child.stdin.write(JSON.stringify({ op: "stop" }) + "\n");
          child.on("close", () => resolve({ events, thread }));
        }
      }
    });
  });
}

// ---------------------------------------------------------------- the suite

test("every engine runner has a case here (a new harness is a new case that is green)", () => {
  const runners = readdirSync(join(repo, "packages/runners/src")).filter((f) => f.endsWith(".ts")).map((f) => basename(f, ".ts"));
  assert.deepEqual(runners.filter((r) => !cases.some((c) => c.script === src(r))), []);
});

for (const c of cases) {
  describe(`runner contract: ${c.name}`, () => {
    let dir = "";
    let s: Setup;
    let d: Describe;
    let app: Awaited<ReturnType<typeof appEnd>>;
    let thread = "";
    before(async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `pagent-conformance-${c.name}-`)));
      s = await c.setup(dir);
      app = await appEnd();
    });
    after(() => {
      s?.close?.();
      app?.server.close();
      rmSync(dir, { recursive: true, force: true });
    });

    test("describe: its harness, how its turns go, the optional ops it answers", async () => {
      const [e] = await op(c, s, { op: "describe" });
      d = e;
      assert.equal(d.type, "describe");
      assert.equal(d.harness?.id, c.id, "its harness's id is its name (what cli takes)");
      assert.ok(d.harness.title, "a title for people");
      assert.ok(["tui", "thread", "headless"].includes(d.turns));
      assert.ok(Array.isArray(d.ops));
      for (const o of d.ops) assert.ok(o in OPS && !requiredOps(d).includes(o), `"${o}" is an optional op`);
      assert.equal(typeof d.interject, "boolean");
      assert.ok(d.sessions === undefined || ["folder", "agent"].includes(d.sessions), "sessions: by folder or by agent");
    });

    if (c.turn) {
      test(`a turn (${c.name.includes("thread") || ["opencode", "gemini", "qwen", "grokbot"].includes(c.name) ? "its session" : "ask"}): well-formed chunks, each call saying what it does, its answer`, async () => {
        if (d.turns === "thread") {
          const { events, thread: t } = await sessionTurn(c, s, [c.turn!.message, ...(c.turn!.then ?? [])], app.url);
          thread = t;
          const turn = events.findIndex((e) => e.type === "turn");
          assert.ok(turn >= 0, "a turn");
          const user = events.find((e) => e.type === "user");
          assert.equal(user?.clientId, "run-1", "its message, the app's run");
          const end = events.findLast((e) => e.type === "turn-end");
          assert.match(String(end.text), c.turn!.answer);
          assert.equal(typeof end.status, "string");
          checkChunks(events.slice(turn).filter((e) => !["turn", "user", "turn-end", "ready"].includes(e.type)), c.name);
        } else {
          const chunks = await askTurn(c, s, c.turn!.message, app.url);
          assert.equal(chunks.at(-1)?.type, "finish", "it ends with finish");
          const result = chunks.find((x) => x.type === "data-result");
          assert.match(String(result?.data?.text), c.turn!.answer);
          checkChunks(chunks, c.name);
        }
        if (c.turn!.asks) assert.ok(app.asked.length, "its permission request reached the app");
      });

      test("its permission requests reach the app in pagent's shape", () => {
        for (const a of app.asked) {
          assert.equal(typeof a.tool, "string");
          assert.ok("input" in a);
          checkMeta(a.meta, `${c.name} permission ${a.tool}`);
        }
      });
    }

    if (c.hook) {
      test("its harness's permission hook asks the app, and says the decision as the harness takes it", async () => {
        const before = app.asked.length;
        // Not spawnSync: the app's end answers in this process.
        const child = spawn(process.execPath, [c.script, "--permission-hook", app.url], { env: { ...env0(), ...s.env }, stdio: ["pipe", "pipe", "inherit"] });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "## Plan\n1. read\n2. fix" } }));
        await new Promise((r) => child.on("close", r));
        const r = { stdout };
        assert.equal(app.asked.length, before + 1);
        const asked = app.asked.at(-1);
        assert.deepEqual(asked.meta, { kind: "proposal", plan: "## Plan\n1. read\n2. fix", asks: true });
        assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, "allow");
      });
    }

    test("history: the conversation, each call saying what it does", async () => {
      const [h] = (await op(c, s, { op: "history", ...(thread ? { thread } : {}) })).filter((e) => e.type === "history");
      checkHistory(h.messages, c);
    });

    test("each optional op it lists answers as the contract says", async () => {
      const type: Partial<Record<Op, string>> = { last: "last", info: "info", usage: "usage", trajectory: "trajectory", holder: "holder", move: "moved", interactive: "command", service: "service" };
      for (const o of d.ops) {
        if (!type[o]) continue;
        const input = o === "move" ? { from: s.cwd, to: s.cwd } : o === "interactive" ? { thread: thread || "t", endpoint: "http://127.0.0.1:1" } : thread ? { thread } : {};
        const events = await op(c, s, { op: o, ...input });
        const e = events.find((x) => x.type === type[o]);
        assert.ok(e, `${c.name}: ${o} answers ${type[o]} (it said ${JSON.stringify(events).slice(0, 300)})`);
        if (o === "usage" && e.usage) checkUsage(e.usage, `${c.name} usage`);
        if (o === "trajectory") checkRecords(e.records, `${c.name} trajectory`);
        if (o === "last") assert.ok(e.text === null || typeof e.text === "string");
        if (o === "info") assert.ok(e.sessionId === null || typeof e.sessionId === "string");
        if (o === "interactive") (assert.equal(typeof e.command, "string"), assert.ok(Array.isArray(e.args)));
      }
    });
  });
}
