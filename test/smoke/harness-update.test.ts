// A harness updated while its agents run (Claude Code's updater moves its link to a new version, Homebrew moves Codex
// to a new folder): what runs the older version is brought up to date once nobody needs it. A TUI (the fake runner's,
// run by a program the test updates): stale ("update"), restarted on its session by itself once quiet with nobody in
// it, never while someone is; a session on a shared service (the fake thread runner's, one service per version, as
// Codex's app-server): moved to the new version's service, and the old service stopped once no session uses it.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeThreadRunner, fakeTuiRunner, testApp, until, type TestApp } from "../lib/app.ts";

const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <div />; }\n`;

/** A program that runs node, at <dir>/bin/<name>: a link to version v1, which `update` moves to the next version. */
function program(dir: string, name: string) {
  let version = 0;
  const link = join(dir, "bin", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const update = () => {
    const file = join(dir, `v${++version}`, name);
    mkdirSync(join(dir, `v${version}`), { recursive: true });
    writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(file, 0o755);
    try {
      unlinkSync(link);
    } catch {}
    symlinkSync(file, link);
  };
  update();
  return { link, update };
}

describe("a harness updated while its agents run", () => {
  let app: TestApp;
  const dir = mkdtempSync(join(tmpdir(), "pagent-update-"));
  const tui = program(dir, "faketui");
  const svc = program(dir, "fakeservice");
  const ask = (node: string, message: string) => app.post<{ text: string }>("/_pagent/ask", { node, agent: "bot", message }).then((r) => r.text);
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  const logged = (re: RegExp) => app.log().split("\n").filter((l) => re.test(l));

  before(async () => {
    app = await testApp(
      {
        "tui/page.tsx": page({ bot: { runner: fakeTuiRunner, bin: tui.link } }),
        "thread/page.tsx": page({ bot: { runner: fakeThreadRunner } }),
      },
      { env: { FAKE_SERVICE_BIN: svc.link, PAGENT_SWEEP_MS: "500", PAGENT_TUI_REFRESH_MS: "1000" } },
    );
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a TUI on the older version: stale, left alone while someone is in it, then restarted on its session by itself", async () => {
    const pid = async () => Number(await ask("/tui", "!sh echo $PPID")); // the TUI the turn runs in
    const first = await pid();
    assert.equal((await status("/tui")).terminal.stale, undefined);

    // Someone is in it: stale, and it stays.
    const ws = new WebSocket(`${app.url.replace("http", "ws")}/_pagent/terminal?node=/tui&agent=bot&cols=80&rows=24`);
    await new Promise((r) => (ws.onmessage = r));
    tui.update();
    await until(async () => (await status("/tui")).terminal.stale === "update", "the TUI to be stale");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(await pid(), first, "not restarted while someone is in it");

    // They leave: once it is quiet, restarted by itself (before any message), on the new version.
    ws.close();
    await until(() => logged(/^restarting the terminal of \/tui#bot: its harness was updated since it started \(.*\/v1\/faketui\)$/).length, "the restart");
    await until(async () => (await status("/tui")).terminal.open && (await status("/tui")).terminal.stale === undefined, "the new TUI");
    const second = await pid();
    assert.notEqual(second, first);
    assert.equal(logged(/restarting the terminal of \/tui#bot/).length, 1, "restarted once");
  });

  test("a session on the older service: moved to the new version's service; the old one stopped once nobody uses it", async () => {
    assert.equal(await ask("/thread", "!say before"), "before");
    svc.update();
    await until(() => logged(/^\/thread#bot: its harness was updated; moving its session to the new one \(fake-service:.*:[0-9a-f]{6}\)$/).length, "the move");
    await until(() => logged(/^stopping fake-service:.*:[0-9a-f]{6}: no session uses it, its harness was updated$/).length, "the old service stopped");
    assert.equal(await ask("/thread", "!say after"), "after");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(logged(/moving its session/).length, 1, "moved once");
  });
});
