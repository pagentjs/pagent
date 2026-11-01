// A message typed into an agent's TUI that the TUI does not take (the fake runner with a TUI; SPEC 13.25): on 10-21 a
// Claude Code TUI lost the Enter after a paste, the message sat in its prompt, and the run waited an hour "starting" with
// the messages after it. Enter waits until the TUI drew the paste; a message still not in after a while gets Enter once
// more, then its run fails and the queue goes on; one the TUI took, only late, is not typed twice.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeTuiRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";

const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <div />; }\n`;

describe("a message its TUI does not take", () => {
  let app: TestApp;
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const users = async (node: string) => lines((await app.get(`/_pagent/history?node=${node}&agent=bot`)).messages).filter((l: string) => l.startsWith("user"));
  // How its TUI behaves from now on (the fake TUI reads these files at each paste and Enter).
  const tui = (node: string, file: string, value: string) => writeFileSync(join(app.root, node, ".state", "bot", file), value);
  const logOf = (node: string) => app.log().split("\n").filter((l) => l.startsWith(`/${node}#bot: its terminal`));

  before(async () => {
    app = await testApp(Object.fromEntries(["lost", "gone", "late", "slow"].map((n) => [`${n}/page.tsx`, page({ bot: { runner: fakeTuiRunner } })])), { env: { PAGENT_TUI_TAKE_MS: "1500" } });
    for (const n of ["lost", "gone", "late", "slow"]) assert.equal(await ask(`/${n}`, "!say up"), "up"); // their TUIs are open
  });
  after(() => app.close());

  test("the Enter after the paste lost: Enter again once the bound passed; the message goes in once, then the one waiting after it", async () => {
    tui("lost", "lose-enter", "1");
    const t = Date.now();
    const first = ask("/lost", "!say one");
    await until(async () => (await status("/lost")).busy, "the run");
    const second = ask("/lost", "!say two");
    assert.equal(await first, "one");
    assert.ok(Date.now() - t >= 1500, "after the bound");
    assert.equal(await second, "two");
    assert.equal(logOf("lost").length, 1);
    assert.match(logOf("lost")[0], /: its terminal started no turn 1\.5 s after a message was typed into it \(it may sit in its prompt\): pressing Enter again$/);
    assert.deepEqual(await users("/lost"), ["user (from /lost): !say up", "user (from /lost): !say one", "user (from /lost): !say two"]);
  });

  test("still not in after Enter again: its run fails and says why, and the message waiting after it goes on", async () => {
    tui("gone", "lose-enter", "2");
    const first = ask("/gone", "!say one");
    await until(async () => (await status("/gone")).busy, "the run");
    const second = ask("/gone", "!say two");
    assert.match(await first, /^its terminal did not take the message: no turn started in it 3 s after it was typed, nor after Enter was pressed again/);
    // What it left in its prompt goes in with the next message (as on 10-21): one turn answers both.
    assert.equal(await second, "one\n\ntwo");
    assert.match(logOf("gone").at(-1)!, /: its terminal did not take the message: .*; the messages after it go on$/);
    assert.equal((await status("/gone")).busy, false);
  });

  test("taken, but its turn started late (after the bound): Enter again finds its prompt empty, and the message is not typed twice", async () => {
    tui("late", "start-delay", "2500");
    assert.equal(await ask("/late", "!say late"), "late");
    tui("late", "start-delay", "0");
    assert.match(logOf("late").join("\n"), /pressing Enter again/);
    assert.ok(!logOf("late").some((l) => l.includes("did not take")));
    assert.deepEqual(await users("/late"), ["user (from /late): !say up", "user (from /late): !say late"]);
    assert.equal(await ask("/late", "!say next"), "next");
  });

  test("a TUI slow to take a paste in (an Enter meanwhile is lost): Enter waits until it drew the paste", async () => {
    tui("slow", "paste-delay", "600");
    assert.equal(await ask("/slow", "!say drawn"), "drawn");
    assert.deepEqual(logOf("slow"), [], "no Enter again: the first one went in");
  });
});
