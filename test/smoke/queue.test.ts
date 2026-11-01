// A person's message written while the agent works, queued on the server (POST /_pagent/queue), not in the page: it
// shows in the agent's status (queued, in order, with who it is from) until its turn comes, goes to the agent after
// the turn in progress as the person's own words, can be withdrawn before then (and never arrives), waits on a shared
// thread too (where a message sent during a turn would join it), and survives a server restart.
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakePage, fakeThreadRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";

const message = (text: string) => ({ id: Math.random().toString(36).slice(2), role: "user", parts: [{ type: "text", text }] });
// A turn that goes on until the test says (a file "go" in the node's folder), then says `said`.
const held = (said: string) => `!sh while [ ! -f go ]; do sleep 0.1; done; echo held\n!say ${said}`;

describe("a person's queued messages", () => {
  let app: TestApp;
  const ask = (node: string, text: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message: text }).then((r) => r.text);
  const queue = (node: string, text: string) => app.post<{ id: string }>("/_pagent/queue", { node, agent: "bot", message: message(text) }).then((r) => r.id);
  const unqueue = (node: string, id: string) => app.post<{ withdrawn: boolean }>("/_pagent/unqueue", { node, agent: "bot", id }).then((r) => r.withdrawn);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const queued = async (node: string) => (await status(node)).queued.map((q: any) => [q.caller.kind, q.user.parts[0].text]);
  const history = async (node: string) => lines((await app.get(`/_pagent/history?node=${node}&agent=bot`)).messages);
  const go = (node: string) => writeFileSync(join(app.root, node, "go"), "");

  before(async () => {
    const thread = `export const agents = ${JSON.stringify({ bot: { runner: fakeThreadRunner } })};\nexport default function Page() { return <div />; }\n`;
    app = await testApp({ "a/page.tsx": fakePage(), "b/page.tsx": fakePage(), "t/page.tsx": thread, "r/page.tsx": fakePage() });
  });
  after(() => app.close());

  test("shown in status until its turn, then the person's words to the agent, in order; one withdrawn never arrives", async () => {
    const first = ask("/a", held("first"));
    await until(async () => (await status("/a")).busy, "the first turn");
    const one = await queue("/a", "!say one");
    const gone = await queue("/a", "!say withdrawn");
    await queue("/a", "!say two");
    assert.deepEqual(await queued("/a"), [["user", "!say one"], ["user", "!say withdrawn"], ["user", "!say two"]]);
    assert.equal((await status("/a")).queued[0].id, one);
    assert.equal(await unqueue("/a", gone), true);
    assert.equal(await unqueue("/a", gone), false, "gone already");
    assert.deepEqual(await queued("/a"), [["user", "!say one"], ["user", "!say two"]]);
    go("a");
    assert.equal(await first, "held\n\nfirst");
    await until(async () => (await history("/a")).at(-1) === "assistant: two", "both queued turns");
    assert.deepEqual((await history("/a")).slice(-5), ["assistant: held first", "user: !say one", "assistant: one", "user: !say two", "assistant: two"]);
    assert.deepEqual(await queued("/a"), []);
    assert.equal(await unqueue("/a", one), false, "its turn came");
    assert.ok(!(await history("/a")).some((l) => l.includes("withdrawn")));
  });

  test("to an idle agent it starts at once and never shows as queued", async () => {
    await queue("/b", "!say at once");
    await until(async () => (await history("/b")).at(-1) === "assistant: at once", "the turn");
    assert.deepEqual(await queued("/b"), []);
  });

  test("on a shared thread it waits for the turn too (not steered into it)", async () => {
    const first = ask("/t", held("first"));
    await until(async () => (await status("/t")).busy, "the first turn");
    await queue("/t", "!say after it");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await queued("/t"), [["user", "!say after it"]]);
    go("t");
    assert.equal(await first, "held\n\nfirst", "the turn answers its own message only");
    await until(async () => (await history("/t")).at(-1) === "assistant: after it", "the queued turn");
    assert.deepEqual((await history("/t")).slice(-2), ["user: !say after it", "assistant: after it"]);
  });

  test("it survives a server restart, still shown, and arrives once the turn is done", async () => {
    void ask("/r", held("first")).catch(() => {});
    await until(async () => (await status("/r")).busy, "the first turn");
    await queue("/r", "!say still here");
    await app.kill();
    await app.start();
    await until(async () => (await queued("/r")).length === 1, "the queue after the restart");
    assert.deepEqual(await queued("/r"), [["user", "!say still here"]]);
    go("r");
    await until(async () => (await history("/r")).at(-1) === "assistant: still here", "the queued turn");
    assert.equal((await history("/r")).filter((l) => l === "user: !say still here").length, 1);
    await until(async () => !(await status("/r")).busy, "idle");
    const state = join(app.home, "state");
    const left = readdirSync(state).flatMap((a) => (existsSync(join(state, a, "inbox")) ? readdirSync(join(state, a, "inbox")) : []));
    assert.deepEqual(left, [], "nothing left in the inbox");
  });
});
