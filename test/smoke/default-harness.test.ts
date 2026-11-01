// The default harness and the settings file, over a real server (SPEC 13.15): an agent declared without a cli follows
// the person's default until it really has a session (a turn that failed keeps nothing), then keeps the harness it is
// on; a settings file that does not read leaves the last good settings in force and is never written over. The real
// claude runner, with a stand-in for Claude Code (CLAUDE_BIN) that fails while a flag file is there.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { testApp, type TestApp } from "../lib/app.ts";
import { fakeClaude } from "../lib/claude.ts";

describe("the default harness, and the settings file", () => {
  let app: TestApp;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pagent-default-harness-")));
  const fail = join(dir, "fail");
  const pin = () => join(app.root, "notes/.state/main/harness.json");
  const harness = async () => (await app.get(`/_pagent/agent-status?node=/notes&agent=main`)).session.harness?.id;
  const put = (patch: unknown) => fetch(`${app.url}/_pagent/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });

  before(async () => {
    // Claude Code that fails (not logged in, say) while the flag is there, and is the stand-in otherwise.
    const real = fakeClaude(dir);
    const gate = join(dir, "claude-gate.mjs");
    writeFileSync(
      gate,
      `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
if (existsSync(${JSON.stringify(fail)})) { console.error("claude: not logged in"); process.exit(1); }
const c = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" });
c.on("close", (code) => process.exit(code ?? 1));
`,
    );
    chmodSync(gate, 0o755);
    app = await testApp(
      {
        "page.tsx": `export default function Home() { return <div />; }\n`,
        "notes/page.tsx": `export const agents = { main: { tui: false } };\nexport default function P() { return <div />; }\n`,
      },
      { env: { CLAUDE_CONFIG_DIR: join(dir, "config"), CLAUDE_BIN: gate } },
    );
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a turn that failed keeps nothing: the agent still follows the default; one that ran keeps its harness", async () => {
    writeFileSync(fail, "");
    await app.post("/_pagent/ask", { node: "/notes", agent: "main", message: "hello" });
    assert.equal(existsSync(pin()), false, "no session: nothing kept");
    assert.equal((await put({ harness: "codex" })).status, 200);
    assert.equal(await harness(), "codex", "it follows the default");
    assert.equal((await put({ harness: "claude" })).status, 200);

    rmSync(fail);
    const { text } = await app.post<{ text: string }>("/_pagent/ask", { node: "/notes", agent: "main", message: "hello again" });
    assert.match(text, /^(new|continue) /);
    assert.deepEqual(JSON.parse(readFileSync(pin(), "utf8")), { harness: "claude" });
    assert.equal((await put({ harness: "codex" })).status, 200);
    assert.equal(await harness(), "claude", "it has talked: its harness stays");
    assert.equal((await put({ harness: null })).status, 200);
  });

  test("a settings file that does not read: the last good settings, no write over it (409); a key from a prototype: 400", async () => {
    assert.equal((await put({ theme: "dark" })).status, 200);
    const file = join(app.home, "settings.json");
    writeFileSync(file, '{ "theme": "light", ');
    const now = await app.get("/_pagent/settings");
    assert.equal(now.theme, "dark", "the last good settings, not the defaults");
    const r = await put({ lang: "en" });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /settings\.json is not JSON .*fix it or remove it/);
    assert.equal(readFileSync(file, "utf8"), '{ "theme": "light", ', "the person's file as it was");
    assert.equal((await put({ constructor: 1 })).status, 400);
    writeFileSync(file, '{ "theme": "light" }\n');
    assert.equal((await app.get("/_pagent/settings")).theme, "light");
    assert.equal((await put({ theme: null })).status, 200);
  });
});
