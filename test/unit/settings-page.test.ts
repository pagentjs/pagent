// The person's settings as a page holds them (bridge/src/settings.ts, SPEC 13.15): what the server says reaches it by more
// than one way (the response to its read, to its write, the event stream), in any order, each with its rev; only a
// newer one is taken. A change made here shows at once and holds until the server answers it; refused, only that
// setting goes back, to what the server says now (not to what it was here before: another tab may have changed it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { provideSettingsWriter, receiveSettings, setSetting, settingsNow } from "../../packages/bridge/src/settings.ts";

/** A server whose answers come when the test says: each write's resolve/reject, in the order they were made. */
function server() {
  const writes: { patch: Record<string, unknown>; ok: (s: object) => void; no: (e: Error) => void }[] = [];
  provideSettingsWriter((patch) => new Promise((ok, no) => writes.push({ patch, ok, no })));
  return writes;
}
const tick = () => new Promise((r) => setTimeout(r));

test("an older rev is left out: a read that lands after a newer event, a response after a newer one", () => {
  receiveSettings({ lang: null, theme: "dark", harness: "claude", harnesses: [{ id: "claude", title: "Claude Code" }], rev: 10 });
  assert.equal(settingsNow().theme, "dark");
  receiveSettings({ lang: null, theme: "light", harness: "claude", rev: 12 }); // the event of a change
  receiveSettings({ lang: null, theme: "dark", harness: "claude", harnesses: [{ id: "claude", title: "Claude Code" }, { id: "codex", title: "Codex" }], rev: 11 }); // a read made before it
  assert.equal(settingsNow().theme, "light");
  assert.equal(settingsNow().harnesses?.length, 2, "the list of harnesses, which only a read has, is taken all the same");
  receiveSettings({ lang: null, theme: "dark", harness: "claude", rev: 12 }); // the same change again: taken (it is not older)
  assert.equal(settingsNow().theme, "dark");
});

test("two changes in a row, their answers in the other order: the later change stays", async () => {
  const writes = server();
  receiveSettings({ lang: null, theme: null, harness: "claude", rev: 20 });
  const a = setSetting("theme", "dark");
  const b = setSetting("theme", "light");
  assert.equal(settingsNow().theme, "light", "shown at once");
  writes[1].ok({ lang: null, theme: "light", harness: "claude", rev: 22 });
  await b;
  writes[0].ok({ lang: null, theme: "dark", harness: "claude", rev: 21 }); // late
  await a;
  assert.equal(settingsNow().theme, "light");
});

test("a change waiting for its answer holds against events of others; an event of another setting shows meanwhile", async () => {
  const writes = server();
  receiveSettings({ lang: null, theme: null, harness: "claude", rev: 30 });
  const a = setSetting("theme", "dark");
  receiveSettings({ lang: "zh-CN", theme: null, harness: "claude", rev: 31 }); // another tab picked a language
  assert.equal(settingsNow().theme, "dark", "not flipped back by an event from before the write");
  assert.equal(settingsNow().lang, "zh-CN");
  writes[0].ok({ lang: "zh-CN", theme: "dark", harness: "claude", rev: 32 });
  await a;
  assert.deepEqual([settingsNow().lang, settingsNow().theme], ["zh-CN", "dark"]);
});

test("refused: only that setting goes back, to the server's (what another tab changed meanwhile stays)", async () => {
  const writes = server();
  receiveSettings({ lang: null, theme: "light", harness: "claude", rev: 40 });
  const a = setSetting("harness", "codex");
  assert.equal(settingsNow().harness, "codex");
  receiveSettings({ lang: "en", theme: "dark", harness: "claude", rev: 41 }); // another tab, meanwhile
  writes[0].no(new Error("harness is one of the harnesses"));
  await assert.rejects(a, /harness is/);
  await tick();
  assert.deepEqual([settingsNow().harness, settingsNow().theme, settingsNow().lang], ["claude", "dark", "en"]);
});
