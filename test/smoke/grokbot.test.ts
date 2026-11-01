// runner:grokbot (SPEC 13.20) on a stand-in gbot (test/lib/fake-gbot.ts; no account, no network): in an app, another
// agent tells the Grok Bot agent something and gets its answer back; its approval card is a permission card, answered
// through the permission endpoint and told to Grok Bot with `gbot approvals respond`; what the bot says on its own
// reaches the history and the views, and what it says outside a turn reaches its turn trigger (phase "message"); an
// agent declared `follow` is followed from the app's start. Its session alone: the ways gbot breaks become what to do
// (in the log only when someone must act), a stop ends pagent's wait, the bot is the declared one (made when the
// declaration says so), what it says outside a turn is told once (`said`), `follow`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, lines, repo, testApp, until, type TestApp } from "../lib/app.ts";

const fakeGbot = join(repo, "test/lib/fake-gbot.ts");
const runner = join(repo, "packages/runners/src/grokbot.ts");
const fast = { GROKBOT_POLL_MS: "50", GROKBOT_QUIET_MS: "400", GROKBOT_IDLE_MS: "150", GROKBOT_FOLLOW_MIN_MS: "100", GBOT_WAKE_RETRY_MS: "100" };
const calls = (dir: string) => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Someone writes to the bot elsewhere (gbot by hand, Grok Bot's own app): no correlation id. */
const elsewhere = (gbotDir: string, bot: string, text: string) => spawnSync(process.execPath, [fakeGbot, "send", bot, "--", text], { env: { ...process.env, FAKE_GBOT_DIR: gbotDir } });
/** A turn trigger's action that logs each event it gets (in the node's turns.log). */
const logAction = `"use server";\nimport { appendFileSync } from "node:fs";\nimport type { TurnEvent } from "pagent";\nexport async function log(e: TurnEvent) {\n  appendFileSync("turns.log", JSON.stringify(e) + "\\n");\n}\n`;

describe("a Grok Bot agent in an app", () => {
  let app: TestApp;
  const gbotDir = mkdtempSync(join(tmpdir(), "pagent-fake-gbot-"));
  const history = async (node: string, agent: string) => lines((await app.get(`/_pagent/history?node=${encodeURIComponent(node)}&agent=${agent}`)).messages);
  const ask = (node: string, agent: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent, message }).then((r) => r.text);
  const card = () => until(async () => (await app.get("/_pagent/prompts")).questions.find((q: any) => q.node === "/g"), "the approval's card");
  const logged = (node: string): any[] => {
    try {
      return readFileSync(join(app.root, node, "turns.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  before(async () => {
    app = await testApp(
      {
        "page.tsx": fakePage(),
        "g/page.tsx": `export const agents = { grok: { cli: "grokbot", bot: "Researcher" } };\nexport const triggers = { log: { turn: "grok", run: "log" } };\nexport default function Page() { return <div />; }\n`,
        "g/actions.ts": logAction,
        // Followed every second from the app's start, though nobody told it anything yet.
        "f/page.tsx": `export const agents = { scout: { cli: "grokbot", bot: "Scout", createBot: true, follow: "1s" } };\nexport const triggers = { log: { turn: "scout", run: "log" } };\nexport default function Page() { return <div />; }\n`,
        "f/actions.ts": logAction,
      },
      { env: { GBOT_BIN: fakeGbot, FAKE_GBOT_DIR: gbotDir, ...fast } },
    );
  });
  after(async () => {
    await app.close();
    rmSync(gbotDir, { recursive: true, force: true });
  });

  test("another agent tells it something; its answer comes back as a message", async () => {
    assert.match(await ask("/", "bot", '!sh pagent tell /g#grok "!say 3 posts about Lisbon trams"'), /Delegated to \/g#grok/);
    await until(async () => (await history("/", "bot")).some((l) => /^user \(from \/g#grok\): Result of your delegation to \/g#grok \(message \S+\):\n3 posts about Lisbon trams$/.test(l)), "the delegation's result");
    assert.deepEqual(await history("/g", "grok"), ["user (from /#bot): !say 3 posts about Lisbon trams", "assistant: 3 posts about Lisbon trams"]);
    const sent = calls(gbotDir).find((a) => a[0] === "send")!;
    assert.deepEqual(sent.slice(0, 2), ["send", "bot-researcher"]);
    assert.ok(sent.includes("--correlation-id"), "the run's id goes as gbot's correlation id");
    const s = await app.get(`/_pagent/agent-status?node=/g&agent=grok&handle=1`);
    assert.deepEqual(s.session.harness, { id: "grokbot", title: "Grok Bot" });
    assert.equal(s.session.can.terminal, false);
    assert.equal(s.session.sessionId, "bot-researcher");
  });

  test("its approval card is a permission card in the app; Allow accepts it once in Grok Bot", async () => {
    const reply = ask("/g", "grok", '!step x_search {"query":"pagent"}\n!approve npm publish\n!say published');
    const q = await card();
    assert.equal(q.kind, "permission");
    assert.match(q.detail, /npm publish/);
    assert.deepEqual(q.options, ["Allow", "Deny"]);
    await app.post("/_pagent/answer", { id: q.id, answer: "Allow" });
    assert.equal(await reply, "published");
    const respond = calls(gbotDir).find((a) => a[0] === "approvals" && a[1] === "respond")!;
    assert.equal(respond[respond.indexOf("--decision") + 1], "accept");
    const { messages } = await app.get(`/_pagent/history?node=/g&agent=grok`);
    const parts = messages.at(-1).parts.filter((p: any) => p.type === "dynamic-tool");
    assert.deepEqual(parts.map((p: any) => [p.toolName, p.toolMetadata.kind, p.state]), [["x_search", "webSearch", "output-available"], ["approval", "command", "output-available"]]);
  });

  test("Deny declines it in Grok Bot", async () => {
    const reply = ask("/g", "grok", "!approve rm -rf build\n!say removed");
    const q = await card();
    await app.post("/_pagent/answer", { id: q.id, answer: "Deny" });
    assert.equal(await reply, "Okay, I won't do that.");
    const respond = calls(gbotDir).findLast((a) => a[0] === "approvals" && a[1] === "respond")!;
    assert.equal(respond[respond.indexOf("--decision") + 1], "decline");
  });

  test("what the bot says on its own, after the turn, reaches the history, and the views hear of it", async () => {
    let heard = "";
    const ctl = new AbortController();
    void fetch(`${app.url}/_pagent/events`, { signal: ctl.signal })
      .then(async (res) => {
        for await (const chunk of res.body!) heard += Buffer.from(chunk).toString("utf8");
      })
      .catch(() => {});
    await until(() => heard.includes("ping"), "the event stream");
    const told = () => heard.split('"node":"/g","agent":"grok","event":{"type":"history"}').length - 1;
    assert.equal(await ask("/g", "grok", "!say on it\n!later 4000 Your digest is ready."), "on it");
    await new Promise((r) => setTimeout(r, 1500)); // what the turn's own end tells the views
    const before = told();
    assert.equal((await history("/g", "grok")).at(-1), "assistant: on it");
    await until(() => told() > before, "the views told the history changed", 20_000);
    assert.equal((await history("/g", "grok")).at(-1), "assistant: Your digest is ready.");
    // The schedule it made shows as a step of the turn that made it (the thread's automation-changed event).
    const { messages } = await app.get(`/_pagent/history?node=/g&agent=grok`);
    const step = messages.at(-2).parts.find((p: any) => p.type === "dynamic-tool");
    assert.deepEqual([step?.toolName, step?.state, step?.output], ["automation-changed", "output-available", "created"]);
    ctl.abort();
  });

  test("what it says outside a turn reaches its turn trigger, once: a reply after its turn ended, a schedule's, one to a message written elsewhere", async () => {
    const before = logged("g").length;
    const asked = "!say first\n!wait 2500\n!say second\n!later 1000 Your digest is ready.";
    assert.equal(await ask("/g", "grok", asked), "first");
    await until(() => logged("g").length >= before + 4, "its words after the turn, as messages");
    assert.equal(elsewhere(gbotDir, "Researcher", "hello from elsewhere").status, 0);
    await until(() => logged("g").length >= before + 5, "its answer to the message written elsewhere");
    await sleep(1000); // nothing more: each is told once
    const [start, end, ...said] = logged("g").slice(before);
    assert.deepEqual([start.phase, end.phase, end.reply], ["start", "end", "first"]);
    // After its turn: that turn's, as its end has it.
    assert.deepEqual(said[0], { phase: "message", runId: end.runId, messageId: end.messageId, agent: "grok", message: asked, from: end.from, reply: "second" });
    // On its own (its schedule): from itself.
    assert.deepEqual(said[1], { phase: "message", runId: "", messageId: said[1].messageId, agent: "grok", message: "", from: "/g#grok", reply: "Your digest is ready." });
    assert.ok(said[1].messageId);
    // To someone who wrote to it elsewhere: that message, from a person.
    assert.deepEqual([said[2].runId, said[2].message, said[2].from, said[2].reply], ["", "hello from elsewhere", "", "Grok heard: hello from elsewhere"]);
    assert.equal(said.length, 3);
    // And its conversation shows that exchange.
    assert.deepEqual((await history("/g", "grok")).slice(-2), ["user: hello from elsewhere", "assistant: Grok heard: hello from elsewhere"]);
  });

  test("declared follow: followed from the app's start, so what it says reaches its trigger though nobody told it anything", async () => {
    await until(() => calls(gbotDir).some((a) => a[0] === "bots" && a[1] === "create" && a.includes("Scout")), "its session, started with the app");
    assert.equal(elsewhere(gbotDir, "Scout", "anything new?").status, 0);
    const got = await until(() => logged("f").find((e) => e.phase === "message"), "its answer, at its trigger");
    assert.deepEqual([got.agent, got.message, got.reply], ["scout", "anything new?", "Grok heard: anything new?"]);
    // Another span declared: its session starts again, with it.
    const starts = () => calls(gbotDir).filter((a) => a[0] === "bots" && a[1] === "get" && a[2] === "Scout").length;
    const before = starts();
    const page = join(app.root, "f/page.tsx");
    writeFileSync(page, readFileSync(page, "utf8").replace('follow: "1s"', 'follow: "2s"'));
    await until(() => starts() > before, "its session, started again");
  });
});

// ---------------------------------------------------------------- its session alone

type Events = {
  events: any[];
  write: (o: unknown) => void;
  /** The next event it picks (from now on). */
  next: (pick: (e: any) => boolean, ms?: number) => Promise<any>;
  /** One it picks, already there or the next. */
  find: (pick: (e: any) => boolean, ms?: number) => Promise<any>;
  /** What it wrote to its log. */
  log: () => string;
  done: Promise<void>;
};

/** A home with the Grok Bot app's session (gbot takes it first); the runner's way by the Cursor login hides it. */
const withApp = (d: string) => {
  mkdirSync(join(d, "home", "Library/Application Support/Grok Bot"), { recursive: true });
  return join(d, "home");
};

/** runner:grokbot's session op on the stand-in (FAKE_GBOT_DIR = dir/gbot), as the daemon runs it. */
function session(dir: string, options: Record<string, unknown> = { bot: "Researcher" }, env: Record<string, string> = {}): Events {
  const child = spawn(process.execPath, [runner], { env: { ...process.env, GBOT_BIN: fakeGbot, FAKE_GBOT_DIR: join(dir, "gbot"), CURSOR_ACCESS_TOKEN: "", ...fast, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(JSON.stringify({ op: "session", cwd: dir, stateDir: join(dir, "state"), options }) + "\n");
  let log = "";
  child.stderr.setEncoding("utf8").on("data", (d) => (log += d));
  const events: any[] = [];
  const waiters: { pick: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  let buf = "";
  const next = (pick: (e: any) => boolean, ms = 15_000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out (${JSON.stringify(events.at(-1))})`)), ms);
      waiters.push({ pick, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const e = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      events.push(e);
      for (const w of waiters.splice(0)) (w.pick(e) ? w.resolve(e) : waiters.push(w));
    }
  });
  return {
    events,
    write: (o) => child.stdin.write(JSON.stringify(o) + "\n"),
    next,
    find: (pick, ms) => Promise.resolve(events.find(pick) ?? next(pick, ms)),
    log: () => log,
    done: new Promise((r) => child.on("close", () => r())),
  };
}

/** One of the runner's quick ops, as the engine asks it (without a thread: no session runs): every event it said. */
function quickOp(dir: string, op: string): Promise<any[]> {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [runner], { env: { ...process.env, GBOT_BIN: fakeGbot, FAKE_GBOT_DIR: join(dir, "gbot"), CURSOR_ACCESS_TOKEN: "", ...fast }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    h.stdout.setEncoding("utf8").on("data", (x) => (out += x));
    h.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    h.stdin.end(JSON.stringify({ op, cwd: dir, stateDir: join(dir, "state") }));
  });
}

describe("runner:grokbot's session", () => {
  let dir = "";
  before(() => (dir = mkdtempSync(join(tmpdir(), "pagent-grokbot-"))));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = (name: string, failure?: string) => {
    const d = join(dir, name);
    mkdirSync(join(d, "gbot"), { recursive: true });
    if (failure) writeFileSync(join(d, "gbot", "failure"), failure);
    return d;
  };

  test("the Grok Bot app with no live session: it says to relaunch the app while its computer is awake", async () => {
    const s = session(fresh("no-session", "no-session"));
    const e = await s.next((e) => e.type === "failed");
    assert.match(e.errorText, /^Grok Bot app has no live session: relaunch it while its computer is awake \(`osascript -e 'tell application "Grok Bot" to quit' && open -a "Grok Bot"`\)/);
    await s.done;
  });

  test("an unpatched gbot and the app's descriptor v3: it says so, and how to update", async () => {
    const s = session(fresh("v3", "v3"));
    assert.match((await s.next((e) => e.type === "failed")).errorText, /^gbot too old for descriptor v3: .*npm i -g grok-bot-cli@latest.*pull\/143/);
    await s.done;
  });

  test("broken after it started: the next turn fails saying what to do, and the one after works again", async () => {
    const d = fresh("later");
    const s = session(d);
    await s.next((e) => e.type === "ready");
    writeFileSync(join(d, "gbot", "failure"), "asleep");
    s.write({ op: "ask", run: "r1", message: "!say hi" });
    assert.match((await s.next((e) => e.type === "ask-failed" || e.type === "turn-end")).errorText ?? "", /^Grok Bot's computer did not answer gbot \(listAgents failed: 417 Expectation Failed\): it is likely asleep; wake it/);
    rmSync(join(d, "gbot", "failure"));
    s.write({ op: "ask", run: "r2", message: "!say back" });
    assert.equal((await s.next((e) => e.type === "turn-end")).text, "back");
    s.write({ op: "stop" });
    await s.done;
  });

  test("asleep, with a Cursor login: the call is made again that way, which wakes the computer; without the app's version, it says so", async () => {
    const d = fresh("woken");
    const s = session(d, { bot: "Researcher" }, { HOME: withApp(d), CURSOR_ACCESS_TOKEN: "test-token", SAND_CLIENT_VERSION: "0.71.2" });
    await s.next((e) => e.type === "ready");
    writeFileSync(join(d, "gbot", "failure"), "asleep");
    s.write({ op: "ask", run: "r1", message: "!say awake" });
    assert.equal((await s.next((e) => e.type === "turn-end")).text, "awake");
    assert.ok(!existsSync(join(d, "gbot", "failure")), "the computer is awake again (the app's way works too)");
    s.write({ op: "stop" });
    await s.done;

    const o = fresh("old");
    const t = session(o, { bot: "Researcher" }, { HOME: withApp(o), CURSOR_ACCESS_TOKEN: "test-token" });
    await t.next((e) => e.type === "ready");
    writeFileSync(join(o, "gbot", "failure"), "asleep");
    t.write({ op: "ask", run: "r1", message: "!say hi" });
    assert.match((await t.next((e) => e.type === "ask-failed" || e.type === "turn-end")).errorText ?? "", /^(Grok Bot: )?Cursor's backend refused gbot's Grok Bot version .*SAND_CLIENT_VERSION/);
    t.write({ op: "stop" });
    await t.done;
  });

  test("a computer that wakes slowly (its first calls time out while it starts): a read is made again until it answers, and the log says nothing", async () => {
    const d = fresh("waking");
    const s = session(d, { bot: "Researcher" }, { HOME: withApp(d), CURSOR_ACCESS_TOKEN: "test-token", SAND_CLIENT_VERSION: "0.71.2" });
    await s.next((e) => e.type === "ready");
    s.write({ op: "ask", run: "r1", message: "!wait 800\n!say awake" });
    await s.next((e) => e.type === "user");
    writeFileSync(join(d, "gbot", "failure"), "waking");
    assert.equal((await s.next((e) => e.type === "turn-end")).text, "awake");
    assert.ok(!existsSync(join(d, "gbot", "failure")), "awake again");
    // Again between turns: still nothing in the log.
    writeFileSync(join(d, "gbot", "failure"), "waking");
    await until(() => !existsSync(join(d, "gbot", "failure")), "woken between turns");
    s.write({ op: "stop" });
    await s.done;
    assert.equal(s.log(), "");
  });

  test("asleep with no way to wake it: one line in the log once five reads in a row failed, saying what to do by hand", async () => {
    const d = fresh("no-login");
    const s = session(d);
    await s.next((e) => e.type === "ready");
    s.write({ op: "ask", run: "r1", message: "!say hi" });
    await s.next((e) => e.type === "turn-end");
    writeFileSync(join(d, "gbot", "failure"), "asleep");
    const reads = () => calls(join(d, "gbot")).filter((a) => a[0] === "thread").length;
    const before = reads();
    await until(() => reads() >= before + 3, "a few failed reads");
    assert.equal(s.log(), "", "not after a few");
    await until(() => s.log(), "the line, after five");
    const at = reads();
    await until(() => reads() >= at + 2, "more failed reads");
    assert.match(s.log(), /^grokbot: reading Researcher's thread failed 5 times in a row: Grok Bot's computer did not answer gbot \(listAgents failed: 417 Expectation Failed\): it is likely asleep; wake it \(open the bot in the Grok Bot app and send it something\), or relaunch the app .*pagent wakes it itself\n$/);
    s.write({ op: "stop" });
    await s.done;
  });

  test("Cursor's backend refuses to wake it: that is said in the log at once, and once", async () => {
    const d = fresh("refused");
    const s = session(d, { bot: "Researcher" }, { HOME: withApp(d), CURSOR_ACCESS_TOKEN: "test-token", SAND_CLIENT_VERSION: "" });
    await s.next((e) => e.type === "ready");
    s.write({ op: "ask", run: "r1", message: "!say hi" });
    await s.next((e) => e.type === "turn-end");
    writeFileSync(join(d, "gbot", "failure"), "asleep");
    await until(() => s.log(), "the line");
    const reads = () => calls(join(d, "gbot")).filter((a) => a[0] === "thread").length;
    const at = reads();
    await until(() => reads() >= at + 2, "more failed reads");
    assert.match(s.log(), /^grokbot: reading Researcher's thread: Cursor's backend refused gbot's Grok Bot version .*SAND_CLIENT_VERSION.*\n$/);
    s.write({ op: "stop" });
    await s.done;
  });

  test("what it says outside a turn is told once (said): a reply after its turn ended, a schedule's, one to a message written elsewhere; and what came while no session read its thread", async () => {
    const d = fresh("said");
    const gbot = join(d, "gbot");
    const s = session(d);
    await s.next((e) => e.type === "ready");
    const asked = "!say first\n!wait 1500\n!say second\n!later 800 digest";
    s.write({ op: "ask", run: "r1", message: asked });
    assert.equal((await s.next((e) => e.type === "turn-end")).text, "first");
    assert.deepEqual((await s.find((e) => e.type === "said" && e.text === "second")).to, { id: "r1", text: asked, run: "r1" });
    assert.equal((await s.find((e) => e.type === "said" && e.text === "digest")).to, undefined);
    elsewhere(gbot, "Researcher", "hello from elsewhere");
    assert.deepEqual((await s.find((e) => e.type === "said" && e.text === "Grok heard: hello from elsewhere")).to.text, "hello from elsewhere");
    await sleep(600);
    assert.deepEqual(s.events.filter((e) => e.type === "said").map((e) => e.text), ["second", "digest", "Grok heard: hello from elsewhere"]);
    // In the history the turn's message is under the run's id (the app keeps its own id for it under that).
    const { messages } = (await quickOp(d, "history"))[0];
    assert.equal(messages.find((m: any) => m.role === "user").id, "r1");
    s.write({ op: "stop" });
    await s.done;

    // No session: a page opening the agent (info) reads the thread after it answered, and tells what it found.
    elsewhere(gbot, "Researcher", "while nobody looked");
    rmSync(join(d, "state", "grokbot-read.json"));
    const info = await quickOp(d, "info");
    assert.equal(info[0].type, "info");
    assert.deepEqual(info.slice(1).map((e) => [e.type, e.text]), [["said", "Grok heard: while nobody looked"]]);
    // A session started later tells what came meanwhile, and nothing told before.
    elsewhere(gbot, "Researcher", "and again");
    const t = session(d);
    await t.next((e) => e.type === "ready");
    await t.find((e) => e.type === "said");
    await sleep(300);
    assert.deepEqual(t.events.filter((e) => e.type === "said").map((e) => e.text), ["Grok heard: and again"]);
    t.write({ op: "stop" });
    await t.done;
  });

  test("follow: between turns the thread is read every so often; without it, not once a turn is a while behind", async () => {
    const d = fresh("follow");
    const s = session(d, { bot: "Researcher", follow: "1s" });
    await s.next((e) => e.type === "ready");
    elsewhere(join(d, "gbot"), "Researcher", "ping");
    assert.ok(await s.find((e) => e.type === "said" && e.text === "Grok heard: ping", 5000));
    s.write({ op: "stop" });
    await s.done;

    const n = fresh("still");
    const t = session(n, { bot: "Researcher" }, { GROKBOT_EXPECT_MS: "500" });
    await t.next((e) => e.type === "ready");
    t.write({ op: "ask", run: "r1", message: "!say hi" });
    await t.next((e) => e.type === "turn-end");
    await sleep(1500);
    const reads = () => calls(join(n, "gbot")).filter((a) => a[0] === "thread").length;
    const at = reads();
    await sleep(1500);
    assert.equal(reads(), at);
    t.write({ op: "stop" });
    await t.done;
  });

  test("no bot declared, or one that is not there: it says which; createBot makes it", async () => {
    let s = session(fresh("none"), {});
    assert.match((await s.next((e) => e.type === "failed")).errorText, /says which bot it is: \{ cli: "grokbot", bot:/);
    s = session(fresh("missing"), { bot: "Scout" });
    assert.match((await s.next((e) => e.type === "failed")).errorText, /No bot or group named "Scout"/);
    const d = fresh("create");
    s = session(d, { bot: "Scout", createBot: true });
    const ready = await s.next((e) => e.type === "ready");
    assert.match(ready.threadId, /^bot-\d+$/);
    assert.ok(calls(join(d, "gbot")).some((a) => a[0] === "bots" && a[1] === "create" && a.includes("Scout")));
    s.write({ op: "stop" });
    await s.done;
  });

  test("a message the thread shows being written (isStreaming) streams, a delta for each new end of it", async () => {
    const s = session(fresh("stream"));
    await s.next((e) => e.type === "ready");
    s.write({ op: "ask", run: "r1", message: "!stream Lisbon has five tram lines" });
    assert.equal((await s.next((e) => e.type === "turn-end")).text, "Lisbon has five tram lines");
    const deltas = s.events.filter((e) => e.type === "text-delta").map((e) => e.delta);
    assert.ok(deltas.length > 1, `in pieces (${JSON.stringify(deltas)})`);
    assert.equal(deltas.join(""), "Lisbon has five tram lines");
    assert.equal(s.events.filter((e) => e.type === "text-start").length, 1);
    assert.equal(s.events.filter((e) => e.type === "text-end").length, 1);
    s.write({ op: "stop" });
    await s.done;
  });

  test("stop: pagent stops waiting (gbot cannot stop Grok Bot); what was queued is never sent; its later words reach the history", async () => {
    const d = fresh("stop");
    const s = session(d);
    await s.next((e) => e.type === "ready");
    s.write({ op: "ask", run: "r1", message: "!wait 1500\n!say finally" });
    s.write({ op: "ask", run: "r2", message: "!say queued" });
    await s.next((e) => e.type === "user" && e.clientId === "r1");
    s.write({ op: "interrupt" });
    assert.equal((await s.next((e) => e.type === "turn-end")).status, "interrupted");
    assert.equal(s.events.find((e) => e.type === "ask-failed")?.run, "r2");
    assert.equal(calls(join(d, "gbot")).filter((a) => a[0] === "send").length, 1);
    const read = () =>
      new Promise<any>((resolve) => {
        const h = spawn(process.execPath, [runner], { env: { ...process.env, GBOT_BIN: fakeGbot, FAKE_GBOT_DIR: join(d, "gbot") }, stdio: ["pipe", "pipe", "ignore"] });
        let out = "";
        h.stdout.setEncoding("utf8").on("data", (x) => (out += x));
        h.on("close", () => resolve(JSON.parse(out.trim().split("\n")[0])));
        h.stdin.end(JSON.stringify({ op: "history", cwd: d, stateDir: join(d, "state") }));
      });
    await until(async () => lines((await read()).messages).includes("assistant: finally"), "its later words");
    s.write({ op: "stop" });
    await s.done;
  });
});
