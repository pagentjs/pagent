// The ACP runner's session (packages/runners/src/lib/acp-runner.ts, SPEC 13.18) where it meets trouble, with a small
// scripted ACP agent in place of the harness (test/lib/acp-fake.ts, through qwen.ts's QWEN_BIN): an interrupt ends the
// messages waiting behind the turn too; a session it remembers that the agent no longer has gives way to a new one (a
// declared one does not); stopping takes what the agent started with it; a harness that is not installed is said.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { repo, until } from "../lib/app.ts";

const runner = join(repo, "packages/runners/src/qwen.ts");
const fake = join(repo, "test/lib/acp-fake.ts");

// The runners still running (a failed test's): stopped at the end (SIGTERM: each takes its agent with it).
const running = new Set<ChildProcess>();
after(() => running.forEach((c) => c.kill()));

type Session = { events: any[]; send: (c: object) => void; exited: Promise<number | null>; next: (pick: (e: any) => boolean, what: string) => Promise<any> };

/** The runner's session op, as the daemon runs it: its events, and commands to it. */
function session(dir: string, input: object, bin = fake): Session {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN|GEMINI|OPENCODE|PAGENT_)/.test(k))) as Record<string, string>;
  const child = spawn(process.execPath, [runner], { cwd: dir, env: { ...env, QWEN_BIN: bin, FAKE_ACP_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  running.add(child);
  child.on("close", () => running.delete(child));
  const events: any[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) events.push(JSON.parse(buf.slice(0, i)));
  });
  child.stderr.resume();
  child.stdin.write(JSON.stringify({ op: "session", cwd: dir, stateDir: join(dir, "state"), env: {}, ...input }) + "\n");
  return {
    events,
    send: (c) => child.stdin.write(JSON.stringify(c) + "\n"),
    exited: new Promise((r) => child.on("close", (code) => r(code))),
    next: (pick, what) => until(() => events.find(pick), what),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the ACP runner's session", () => {
  const dirs: string[] = [];
  const fresh = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "pagent-acp-")));
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test("an interrupt ends the turn and every message waiting behind it (each run hears it); usage at the turn's end", async () => {
    const dir = fresh();
    const s = session(dir, {});
    await s.next((e) => e.type === "ready", "ready");
    s.send({ op: "ask", run: "r1", message: "hello" });
    await s.next((e) => e.type === "turn-end" && e.turnId === "r1", "the first turn");
    const usage = s.events.find((e) => e.type === "data-usage");
    assert.deepEqual([usage.data.input, usage.data.output], [10, 2]);
    s.send({ op: "ask", run: "r2", message: "!wait" });
    s.send({ op: "ask", run: "r3", message: "next" });
    s.send({ op: "ask", run: "r4", message: "and next" });
    await s.next((e) => e.type === "turn" && e.turnId === "r2", "the long turn");
    s.send({ op: "interrupt" });
    await s.next((e) => e.type === "turn-end" && e.turnId === "r2", "the long turn's end");
    assert.deepEqual(s.events.filter((e) => e.type === "ask-failed").map((e) => [e.run, e.errorText]), [["r3", "interrupted"], ["r4", "interrupted"]]);
    assert.equal(s.events.filter((e) => e.type === "turn" && (e.turnId === "r3" || e.turnId === "r4")).length, 0);
    // The next message is a turn of its own; the tokens are summed as they go.
    s.send({ op: "ask", run: "r5", message: "after" });
    await s.next((e) => e.type === "turn-end" && e.turnId === "r5", "the next turn");
    const usages = s.events.filter((e) => e.type === "data-usage");
    assert.deepEqual([usages.at(-1).data.input, usages.at(-1).data.output], [20, 4], "summed as it goes");
    s.send({ op: "stop" });
    assert.equal(await s.exited, 0);
  });

  test("a session it remembers that the agent no longer has: a new one, remembered instead; a declared one: an error", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state/session.json"), JSON.stringify({ sessionId: "lost-1" }));
    const s = session(dir, { ownSession: true });
    const ready = await s.next((e) => e.type === "ready" || e.type === "failed", "ready");
    assert.equal(ready.type, "ready");
    assert.notEqual(ready.threadId, "lost-1");
    assert.equal(JSON.parse(readFileSync(join(dir, "state/session.json"), "utf8")).sessionId, ready.threadId);
    s.send({ op: "stop" });
    await s.exited;

    // The same one again: it opens (resumed), not another.
    const again = session(dir, { ownSession: true });
    assert.equal((await again.next((e) => e.type === "ready", "ready")).threadId, ready.threadId);
    again.send({ op: "stop" });
    await again.exited;

    const other = fresh();
    const declared = session(other, { seedSession: "adopted-1" });
    const failed = await declared.next((e) => e.type === "ready" || e.type === "failed", "failed");
    assert.equal(failed.type, "failed");
    assert.match(failed.errorText, /Session not found: adopted-1/);
    assert.equal(await declared.exited, 2);
  });

  test("stopping (or idle close) takes what the agent started with it: its process group, not only the agent", async () => {
    const dir = fresh();
    const s = session(dir, {});
    await s.next((e) => e.type === "ready", "ready");
    s.send({ op: "ask", run: "r1", message: "!child" });
    await s.next((e) => e.type === "turn-end", "the turn");
    const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    assert.ok(alive(pid), "the background process runs");
    s.send({ op: "stop" });
    await s.exited;
    await until(() => !alive(pid), "the background process to be gone", 6000);
  });

  test("a harness that is not installed: said (failed: not found), not a crash", async () => {
    const dir = fresh();
    const s = session(dir, {}, join(dir, "no-such-qwen"));
    const failed = await s.next((e) => e.type === "failed", "failed");
    assert.equal(failed.errorText, `${join(dir, "no-such-qwen")} not found`);
    assert.equal(await s.exited, 2);
  });
});
