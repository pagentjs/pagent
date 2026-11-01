// An agent's session as a timeline (SPEC 13.17): the runners' "trajectory" op on a real session's record (the fixtures
// of test/unit/trajectory.test.ts: Claude Code's transcripts in an isolated CLAUDE_CONFIG_DIR, a Codex rollout in an
// isolated CODEX_HOME with no app-server up), and the engine's /_pagent/trajectory over the fake runner: each turn under
// the app's id for it (the conversation's, a turn trigger's), who a message came from, whether it came through the app,
// a permission card's wait on the person in the turn it was asked in, long records cut and one whole by its id.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, repo, testApp, until, type TestApp } from "../lib/app.ts";

const fixtures = join(repo, "test/fixtures/trajectory");
type Rec = { id: string; turnId: string | null; kind: string; start: number; end?: number; name?: string; input?: unknown; output?: unknown; via?: string; from?: { kind: string; path?: string }; parent?: string; costUSD?: number; truncated?: boolean; wait?: string };

/** One op of an engine runner, its "trajectory" line. */
const trajectoryOf = (runner: string, input: object, env: Record<string, string>) =>
  execFileSync(process.execPath, [join(repo, "packages/runners/src", `${runner}.ts`)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } })
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((l) => l.type === "trajectory") as { records: Rec[]; file?: string; watch?: string[] };

describe("the runners' trajectory op on a session's own record", () => {
  const dir = mkdtempSync(join(tmpdir(), "pagent-trajectory-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("claude: the agent's session (its sessionId) and its sub-agents', watched", () => {
    cpSync(join(fixtures, "claude"), join(dir, "claude/projects"), { recursive: true });
    const session = readdirSync(join(dir, "claude/projects/-Users-sam-code-lisbon")).find((f) => f.endsWith(".jsonl"))!.replace(/\.jsonl$/, "");
    mkdirSync(join(dir, "work"));
    const out = trajectoryOf("claude", { op: "trajectory", cwd: join(dir, "work"), stateDir: join(dir, "state"), seedSession: session }, { CLAUDE_CONFIG_DIR: join(dir, "claude") });
    assert.equal(out.records.filter((r) => r.kind === "turn").length, 8);
    assert.equal(out.records.filter((r) => r.kind === "subagent").length, 2);
    assert.ok(out.records.some((r) => r.parent));
    assert.match(out.file!, new RegExp(`${session}\\.jsonl$`));
    assert.ok(out.watch!.some((w) => w.endsWith("subagents")), "the sub-agents' folder is watched");
    // No session: nothing, and no file.
    const none = trajectoryOf("claude", { op: "trajectory", cwd: join(dir, "work"), stateDir: join(dir, "none"), ownSession: true }, { CLAUDE_CONFIG_DIR: join(dir, "claude") });
    assert.deepEqual(none, { type: "trajectory", records: [] });
  });

  test("codex: the agent's thread, found by its id when no app-server is up, and its sub-agent's rollout", () => {
    cpSync(join(fixtures, "codex"), join(dir, "codex"), { recursive: true });
    const day = join(dir, "codex/sessions/2026/10/18");
    const main = readdirSync(day).sort()[0]; // the thread's rollout came first, its sub-agent's after
    const thread = /-([0-9a-f-]{36})\.jsonl$/.exec(main)![1];
    const out = trajectoryOf("codex", { op: "trajectory", cwd: "/Users/sam/code/lisbon", stateDir: join(dir, "cstate"), seedSession: thread }, { CODEX_HOME: join(dir, "codex"), PAGENT_HOME: join(dir, "home") });
    assert.equal(out.records.filter((r) => r.kind === "turn").length, 4);
    const [agent] = out.records.filter((r) => r.kind === "subagent");
    assert.ok(out.records.filter((r) => r.parent === agent.id).length >= 3);
    assert.equal(out.file, join(day, main));
    assert.equal(out.watch!.length, 1, "the sub-agent's rollout is watched");

    // A sub-agent's rollout in another day's folder: found by one walk, and remembered in the agent's state.
    const child = readdirSync(day).sort()[1];
    const childId = /-([0-9a-f-]{36})\.jsonl$/.exec(child)![1];
    mkdirSync(join(dir, "codex/sessions/2026/10/19"), { recursive: true });
    renameSync(join(day, child), join(dir, "codex/sessions/2026/10/19", child));
    const moved = trajectoryOf("codex", { op: "trajectory", cwd: "/Users/sam/code/lisbon", stateDir: join(dir, "cstate2"), seedSession: thread }, { CODEX_HOME: join(dir, "codex"), PAGENT_HOME: join(dir, "home") });
    assert.equal(moved.records.filter((r) => r.parent === agent.id).length, out.records.filter((r) => r.parent === agent.id).length);
    assert.equal(JSON.parse(readFileSync(join(dir, "cstate2/rollouts.json"), "utf8"))[childId], join(dir, "codex/sessions/2026/10/19", child));
  });
});

describe("/_pagent/trajectory: what the app adds", () => {
  let app: TestApp;
  const page = `export const agents = { main: { runner: ${JSON.stringify(fakeRunner)} } };\nexport default function P() { return <div />; }\n`;
  const records = () => app.get<{ records: Rec[] }>("/_pagent/trajectory?node=/s&agent=main").then((r) => r.records);
  const chat = (id: string, text: string) =>
    fetch(`${app.url}/_pagent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "/s", agent: "main", clientId: "c1", message: { id, role: "user", parts: [{ type: "text", text }] } }),
    }).then((r) => r.text());

  before(async () => {
    app = await testApp({ "page.tsx": `export default function Home() { return <div />; }\n`, "s/page.tsx": page });
  });
  after(() => app.close());

  test("each turn under the app's id; a person's message came through the app, a page's says so", async () => {
    await chat("sam-1", "!sh echo hi");
    await app.post("/_pagent/ask", { node: "/s", agent: "main", message: "!say from the page" });
    const rs = await records();
    const turns = rs.filter((r) => r.kind === "turn");
    assert.deepEqual(turns.map((t) => [t.turnId, t.name, t.via, t.from?.kind]), [
      ["sam-1", "!sh echo hi", "app", undefined],
      [turns[1].turnId, "!say from the page", "app", "page"],
    ]);
    const history = (await app.get<{ messages: { id: string; role: string }[] }>("/_pagent/history?node=/s&agent=main")).messages;
    assert.deepEqual(turns.map((t) => t.turnId), history.filter((m) => m.role === "user").map((m) => m.id), "the conversation's ids");
    const call = rs.find((r) => r.kind === "tool")!;
    assert.deepEqual([call.turnId, call.name, call.output], ["sam-1", "Bash", "hi"]);
    assert.equal(rs.find((r) => r.kind === "user" && r.turnId === turns[1].turnId)!.from?.path, "/s");
  });

  test("a permission card: the wait on the person, from asking to answering, in the turn it was asked in", async () => {
    const turn = chat("sam-2", "!sleep 1500");
    await until(async () => (await app.get<{ busy: boolean }>("/_pagent/agent-status?node=/s&agent=main")).busy, "the turn to start");
    // What a runner sends when its harness asks (runners/src/lib/contract.ts, PermissionRequest).
    const hook = app.post<any>("/_pagent/permission?node=/s&agent=main", { tool: "Bash", input: { command: "curl example.com" }, meta: { kind: "command", command: "curl example.com" } });
    const q = await until(async () => (await app.get<{ questions: { id: string }[] }>("/_pagent/prompts")).questions[0], "the card");
    await new Promise((r) => setTimeout(r, 300));
    await app.post("/_pagent/answer", { id: q.id, answer: "Allow" });
    assert.equal((await hook).decision.allow, true);
    await turn;
    const wait = (await records()).find((r) => r.kind === "wait")!;
    assert.deepEqual([wait.turnId, wait.wait, wait.name, wait.input, wait.output], ["sam-2", "permission", "Allow Bash?", "curl example.com", "Allow"]);
    assert.ok(wait.end! - wait.start >= 300);
  });

  test("a long record is cut in the list and whole by its id", async () => {
    await chat("sam-3", "!sh printf '%3000s' | tr ' ' x");
    const call = (await records()).find((r) => r.kind === "tool" && r.turnId === "sam-3")!;
    assert.equal(call.truncated, true);
    assert.ok((call.output as string).length < 1300);
    const whole = await app.get<{ record: Rec }>(`/_pagent/trajectory?node=/s&agent=main&id=${encodeURIComponent(call.id)}`);
    assert.equal((whole.record.output as string).length, 3000);
    assert.equal(whole.record.truncated, undefined);
    await assert.rejects(app.get("/_pagent/trajectory?node=/s&agent=main&id=nope"), /404/);
  });

  test("after=<at>: only what changed since, and the ids that went away; another server's at, or none: all of it", async () => {
    const whole = await app.get<{ records: Rec[]; at: string; whole: boolean }>("/_pagent/trajectory?node=/s&agent=main");
    assert.equal(whole.whole, true);
    const same = await app.get<{ records: Rec[]; removed: string[]; at: string; whole: boolean }>(`/_pagent/trajectory?node=/s&agent=main&after=${whole.at}`);
    assert.deepEqual([same.whole, same.records, same.removed], [false, [], []], "nothing changed: nothing sent");
    await chat("sam-4", "!say one more");
    const next = await app.get<{ records: Rec[]; removed: string[]; at: string; whole: boolean }>(`/_pagent/trajectory?node=/s&agent=main&after=${whole.at}`);
    assert.equal(next.whole, false);
    assert.ok(next.records.length && next.records.every((r) => r.turnId === "sam-4"), `only the new turn's: ${JSON.stringify(next.records.map((r) => r.turnId))}`);
    assert.notEqual(next.at, whole.at);
    const all = await app.get<{ records: Rec[] }>("/_pagent/trajectory?node=/s&agent=main");
    assert.equal(all.records.length, whole.records.length + next.records.length);
    assert.equal(new Set(all.records.map((r) => r.id)).size, all.records.length, "every id once");
    for (const at of ["elsewhere.3", "nonsense", `${whole.at.split(".")[0]}.999999999`]) assert.equal((await app.get(`/_pagent/trajectory?node=/s&agent=main&after=${at}`)).whole, true, at);
  });

  test("a read that takes long: what the harness wrote meanwhile is read the next time, not taken as unchanged", async () => {
    const state = join(app.root, "s/.state/main");
    const transcript = join(state, "transcript.jsonl");
    const line = (uuid: string, text: string) => appendFileSync(transcript, JSON.stringify({ uuid, type: "user", text, at: new Date().toISOString() }) + "\n");
    await records();
    await records(); // read twice: kept, with its stamp
    line("late-1", "typed in a terminal");
    writeFileSync(join(state, "slow-trajectory"), "800");
    const slow = records();
    await new Promise((r) => setTimeout(r, 300));
    line("late-2", "typed while it was being read");
    assert.ok((await slow).some((r) => r.id === "late-1") && !(await slow).some((r) => r.id === "late-2"), "the slow read has what was there when it read");
    rmSync(join(state, "slow-trajectory"));
    assert.ok((await records()).some((r) => r.id === "late-2"), "the line written during the read is not lost");
  });

  test("an agent that is not declared: 404, and nothing read or written outside the app", async () => {
    for (const agent of ["nobody", "../../x", ".."]) {
      await assert.rejects(app.get(`/_pagent/trajectory?node=/s&agent=${encodeURIComponent(agent)}`), /404/, agent);
      await assert.rejects(app.post(`/_pagent/permission?node=/s&agent=${encodeURIComponent(agent)}`, { tool: "Bash", input: {}, meta: { kind: "command" } }), /404/, agent);
    }
    assert.equal(existsSync(join(app.root, "..", "x")), false);
    assert.equal((await app.get<{ questions: unknown[] }>("/_pagent/prompts")).questions.length, 0, "no card");
  });

  test("a permission card open when the server went away: its wait ends (gone), not open for ever", async () => {
    const turn = chat("sam-5", "!sleep 3000").catch(() => "");
    await until(async () => (await app.get<{ busy: boolean }>("/_pagent/agent-status?node=/s&agent=main")).busy, "the turn to start");
    const hook = app.post<any>("/_pagent/permission?node=/s&agent=main", { tool: "Bash", input: { command: "rm -rf build" }, meta: { kind: "command", command: "rm -rf build" } }).catch(() => null);
    await until(async () => (await app.get<{ questions: unknown[] }>("/_pagent/prompts")).questions.length, "the card");
    await app.kill();
    await Promise.all([hook, turn]);
    await app.start();
    const wait = await until(async () => (await records()).find((r) => r.kind === "wait" && r.name === "Allow Bash?" && r.input === "rm -rf build"), "the wait");
    assert.equal(typeof wait.end, "number", "it ended");
    assert.ok(wait.end! >= wait.start);
    assert.equal((wait as Rec & { gone?: boolean }).gone, true);
  });
});
