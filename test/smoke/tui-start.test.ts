// Starting an agent's TUI (the fake runner with a TUI): one that does not come up (a question its shell asks first, as
// Oh My Zsh's update prompt did to an app's main agent) runs its turns headless, says why in the log on every try and on the
// page, and is tried again; one whose declaration changed since it started (a settings page wrote another model) is
// stale: restarted before the agent's next message unless someone is in it, or by the page's button.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeTuiRunner, testApp, until, type TestApp } from "../lib/app.ts";

const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <div />; }\n`;
const ASKS = "[oh-my-zsh] Would you like to update? [Y/n]";

describe("starting an agent's TUI", () => {
  let app: TestApp;
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const notUp = () => app.log().split("\n").filter((l) => l.startsWith("the terminal of /stuck#bot did not come up"));

  before(async () => {
    app = await testApp(
      {
        "stuck/page.tsx": page({ bot: { runner: fakeTuiRunner, asks: ASKS } }),
        "model/page.tsx": page({ bot: { runner: fakeTuiRunner, model: "a" } }),
      },
      { env: { PAGENT_TUI_UP_MS: "1500", PAGENT_TUI_RETRY_MS: "4000" } },
    );
  });
  after(() => app.close());

  test("a TUI that does not come up: its turns run headless, and the log and the page say why; tried again later, said again", async () => {
    assert.equal(await ask("/stuck", "!say headless"), "headless");
    const [line] = notUp();
    assert.match(line, /: it did not say it was up within 1\.5 s; its screen showed: "\[oh-my-zsh\] Would you like to update\? \[Y\/n\]"\. Its turns run headless for 4 s, or until its terminal is opened by hand$/);
    const s = await status("/stuck");
    assert.equal(s.terminal.open, false);
    assert.match(s.headless.why, /its screen showed: "\[oh-my-zsh\] Would you like to update/);
    assert.ok(s.headless.retryAt > Date.now(), "when it is tried again");
    // Meanwhile: headless at once, not tried again.
    const t = Date.now();
    assert.equal(await ask("/stuck", "!say still headless"), "still headless");
    assert.ok(Date.now() - t < 1500, "not waiting for a TUI");
    assert.equal(notUp().length, 1);
    // Once it is time: tried again, and said again.
    await until(async () => (await status("/stuck")).headless === null, "the time to try again");
    assert.equal(await ask("/stuck", "!say tried again"), "tried again");
    assert.equal(notUp().length, 2);
  });

  test("its declaration changed: the TUI is stale, restarted before the next message (not while someone is in it), or by the page", async () => {
    const tui = async () => Number(await ask("/model", "!sh echo $PPID")); // the TUI the turn runs in
    const first = await tui();
    assert.equal((await status("/model")).terminal.stale, undefined);
    const declare = (model: string) => writeFileSync(join(app.root, "model", "page.tsx"), page({ bot: { runner: fakeTuiRunner, model } }));

    // Someone is in it: it stays, stale, until they restart it.
    declare("b");
    await until(async () => (await status("/model")).terminal.stale === "settings", "the TUI to be stale");
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/model&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    assert.equal(await tui(), first);
    const closed = new Promise((r) => (ws.onclose = r));
    assert.deepEqual(await app.post("/_pagent/terminal/restart", { node: "/model", agent: "bot" }), { said: "restarted its terminal" });
    assert.equal((await closed as CloseEvent).code, 4000, "its viewer is told to reconnect");
    const second = await tui();
    assert.notEqual(second, first);
    assert.equal((await status("/model")).terminal.stale, undefined);

    // Nobody in it: restarted before the next message, with the new declaration.
    declare("c");
    await until(async () => (await status("/model")).terminal.stale === "settings", "the TUI to be stale again");
    const third = await tui();
    assert.notEqual(third, second);
    assert.match(app.log(), /restarting the terminal of \/model#bot: its declaration changed since it started/);
    assert.equal((await status("/model")).terminal.stale, undefined);
  });
});
