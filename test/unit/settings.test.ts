// The person's settings (core/src/settings.ts, SPEC 13.15): one file for the whole machine, <PAGENT_HOME>/settings.json.
// Read with defaults, written key by key (null: the default again), refused when a key or a value is none it takes, the
// keys it does not know kept; an agent declared without a cli takes the default harness on its first turn and keeps it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentDecl } from "../../packages/core/src/agents/runner.ts";
import { Nodes } from "../../packages/core/src/nodes.ts";
import { harnessOf, pinHarness, readSettings, SettingsBroken, settingsBroken, settingsError, settingsFile, watchSettings, writeSettings } from "../../packages/core/src/settings.ts";

const home = mkdtempSync(join(tmpdir(), "pagent-settings-"));
const was = process.env.PAGENT_HOME;
before(() => (process.env.PAGENT_HOME = home));
after(() => {
  if (was === undefined) delete process.env.PAGENT_HOME;
  else process.env.PAGENT_HOME = was;
  rmSync(home, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(settingsFile(), "utf8"));

test("no file: the defaults; the file is in PAGENT_HOME", () => {
  assert.equal(settingsFile(), join(home, "settings.json"));
  assert.deepEqual(readSettings(), { lang: null, theme: null, harness: "claude" });
});

test("a round trip: written key by key, read back; null is the default again (the key leaves the file)", () => {
  assert.deepEqual(writeSettings({ theme: "dark" }), { lang: null, theme: "dark", harness: "claude" });
  assert.deepEqual(writeSettings({ lang: "zh-CN", harness: "codex" }), { lang: "zh-CN", theme: "dark", harness: "codex" });
  assert.deepEqual(onDisk(), { theme: "dark", lang: "zh-CN", harness: "codex" });
  assert.deepEqual(readSettings(), { lang: "zh-CN", theme: "dark", harness: "codex" });
  assert.deepEqual(writeSettings({ harness: null, theme: null }), { lang: "zh-CN", theme: null, harness: "claude" });
  assert.deepEqual(onDisk(), { lang: "zh-CN" });
  writeSettings({ lang: null });
});

test("refused: a key that is no setting, a value it does not take; nothing is written", () => {
  assert.match(settingsError({ colour: "red" }) ?? "", /no setting "colour" \(there are lang, theme, harness\)/);
  assert.match(settingsError({ theme: "blue" }) ?? "", /theme is "light", "dark" or null/);
  assert.match(settingsError({ harness: "gpt" }) ?? "", /harness is one of the harnesses: "claude", "codex"/);
  assert.match(settingsError({ lang: "not a tag" }) ?? "", /lang is a language tag/);
  assert.match(settingsError([]) ?? "", /settings are \{ key: value \}/);
  assert.equal(settingsError({ lang: "en-GB", theme: null }), null);
  assert.throws(() => writeSettings({ theme: "dark", harness: "gpt" }), /harness is/);
  assert.equal(readSettings().theme, null);
  // A key an object has from its prototype is no setting either (it was a 500).
  assert.match(settingsError({ constructor: 1 }) ?? "", /no setting "constructor"/);
  assert.match(settingsError(JSON.parse('{"__proto__": 1}')) ?? "", /no setting "__proto__"/);
});

test("what it does not know is kept (a newer pagent's key) and never read; a value it does not take reads as the default", () => {
  writeFileSync(settingsFile(), JSON.stringify({ fontSize: 15, theme: "sepia", harness: "codex" }));
  assert.deepEqual(readSettings(), { lang: null, theme: null, harness: "codex" });
  writeSettings({ theme: "light" });
  assert.deepEqual(onDisk(), { fontSize: 15, theme: "light", harness: "codex" });
  writeSettings({ harness: "claude" });
  assert.deepEqual(onDisk(), { fontSize: 15, theme: "light", harness: "claude" });
  writeFileSync(settingsFile(), JSON.stringify({ harness: "codex" }));
  assert.deepEqual(readSettings(), { lang: null, theme: null, harness: "codex" }, "a change by hand is read at once");
  writeSettings({ harness: null, theme: null });
});

test("a file that does not read: the last good settings stay in force, and it is never written over", () => {
  writeSettings({ theme: "dark", harness: "codex" });
  writeFileSync(settingsFile(), '{ "theme": "light", ');
  assert.deepEqual(readSettings(), { lang: null, theme: "dark", harness: "codex" }, "not the defaults");
  assert.match(settingsBroken() ?? "", /settings\.json is not JSON/);
  assert.throws(() => writeSettings({ lang: "en" }), (e: Error) => e instanceof SettingsBroken && /fix it or remove it/.test(e.message));
  assert.equal(readFileSync(settingsFile(), "utf8"), '{ "theme": "light", ', "the person's file as it was");
  writeFileSync(settingsFile(), "[1]");
  assert.match(settingsBroken() ?? "", /is not \{ key: value \}/);
  assert.equal(readSettings().theme, "dark");
  rmSync(settingsFile());
  assert.equal(settingsBroken(), null);
  assert.deepEqual(readSettings(), { lang: null, theme: null, harness: "claude" }, "no file: the defaults");
});

test("watched: a change by hand (another app, the person) is told once; a write here and its sight of it are one change", async () => {
  const heard: unknown[] = [];
  const w = watchSettings((s) => heard.push(s.theme));
  w.changed(writeSettings({ theme: "dark" }));
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(settingsFile(), "{ half a file");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(heard, ["dark"], "a file that does not read tells nothing");
  writeFileSync(settingsFile(), JSON.stringify({ theme: "light" }));
  for (let i = 0; i < 50 && heard.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(heard, ["dark", "light"]);
  writeSettings({ theme: null });
});

test("each change has a rev, higher than the one before (and than the clock when the server started); the same settings, the same rev", async () => {
  const started = Date.now();
  const heard: number[] = [];
  const w = watchSettings((_s, rev) => heard.push(rev));
  const a = w.changed(writeSettings({ theme: "dark" }));
  const b = w.changed(writeSettings({ theme: "light" }));
  assert.ok(a >= started && b > a, `${started} ≤ ${a} < ${b}`);
  assert.equal(w.changed(readSettings()), b, "nothing changed: the same rev");
  assert.deepEqual(heard, [a, b]);
  await new Promise((r) => setTimeout(r, 300)); // its watcher's sight of the writes: no change of its own
  assert.deepEqual(heard, [a, b]);
  writeSettings({ theme: null });
});

test("an agent without a cli follows the default until it has a session, then keeps the harness it is on", () => {
  const dir = join(home, "app", "notes");
  mkdirSync(dir, { recursive: true });
  writeSettings({ harness: "codex" });
  assert.equal(harnessOf(dir, "main"), "codex");
  writeSettings({ harness: "claude" });
  assert.equal(harnessOf(dir, "main"), "claude", "no session yet: the default as it is now");
  pinHarness(dir, "main", "claude");
  writeSettings({ harness: "codex" });
  assert.equal(harnessOf(dir, "main"), "claude", "kept");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".state", "main", "harness.json"), "utf8")), { harness: "claude" });
  pinHarness(dir, "main", "codex");
  assert.equal(harnessOf(dir, "main"), "claude", "written once");
  assert.equal(harnessOf(dir, "other"), "codex", "per agent");
  pinHarness(dir, "odd", "gpt");
  assert.equal(existsSync(join(dir, ".state", "odd", "harness.json")), false, "no harness there is: nothing");
  pinHarness(join(home, "app", "gone"), "main", "claude"); // a folder that is not there: nothing
  writeSettings({ harness: null });
});

test("a node's agent without a cli: the default harness's runner; about to run is not having a session", async () => {
  const root = join(home, "app2");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "page.tsx"), `export const agents = { main: {}, fixed: { cli: "claude" } };\nexport default function P() { return null; }\n`);
  const nodes = new Nodes(root);
  const ctx = { root, nodes, baseUrl: "http://127.0.0.1:1" };
  const runners = async () => Object.fromEntries((await nodes.declarations("/notes")).manifest.agents.map((a) => [a.name, a.runner]));
  assert.deepEqual(await runners(), { main: "claude", fixed: "claude" });
  writeSettings({ harness: "codex" });
  assert.deepEqual(await runners(), { main: "codex", fixed: "claude" }, "the default now: no code changed");
  assert.equal((await agentDecl(ctx, { node: "/notes", agent: "main" })).runner, "codex");
  await agentDecl(ctx, { node: "/notes", agent: "fixed" });
  writeSettings({ harness: "claude" });
  // A turn that never made a session (it failed, a terminal opened and left) kept nothing: it follows the default.
  assert.deepEqual(await runners(), { main: "claude", fixed: "claude" });
  assert.equal(existsSync(join(root, "notes", ".state", "main", "harness.json")), false, "about to run: nothing kept");
  assert.equal(existsSync(join(root, "notes", ".state", "fixed", "harness.json")), false, "a cli of its own: nothing kept");
  writeSettings({ harness: null });
});
