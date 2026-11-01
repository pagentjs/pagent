// The person's settings in a real browser (SPEC 13.15): one file for the whole machine, so two apps of one person
// (two servers, one PAGENT_HOME) and every tab of each follow a change made in any of them, live: the shell, the
// pages (their frames' colors, useSettings), server code (settings()). Settings are the shell's: a gear at the bottom
// of the rail (in the top bar of an app with one page), a dialog with the language, the theme and the default harness,
// and the app's own part when its home page exports one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("the person's settings, the same in every app", () => {
  let one: TestApp;
  let two: TestApp;
  let browser: Browser;

  let mcp: Server;

  before(async () => {
    buildShell();
    mcp = await mcpApp();
    one = await testApp({
      "m/page.tsx": `import Panel from "mcp://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp#show";\nexport default function M() { return <Panel />; }\n`,
      // One whose view takes a while to load (an image it waits for): the host connects to it only then.
      "slow/page.tsx": `import Panel from "mcp://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp#slow";\nexport default function S() { return <Panel />; }\n`,
      // The app's own part of Settings: its home page's Settings export, in the home page's scope (its data).
      "page.tsx": `import { useData } from "pagent";
export const metadata = { title: "Notes" };
export default function Home() { return <p className="home">home</p>; }
export function Settings() {
  const [prefs, setPrefs] = useData<{ wrap: boolean }>("prefs.json", { wrap: false });
  return <label className="app-part"><input type="checkbox" checked={!!prefs?.wrap} onChange={(e) => setPrefs({ wrap: e.target.checked })} /> wrap lines</label>;
}
`,
      "b/page.tsx": `import { useSettings, useTheme } from "pagent";
import { harness } from "./actions";
import { useEffect, useState } from "react";
export const metadata = { title: "Board" };
export default function Board() {
  const s = useSettings();
  const theme = useTheme();
  const [server, setServer] = useState("");
  useEffect(() => void harness().then(setServer), [s.harness]);
  return (
    <div>
      <div className="card" style={{ background: "var(--pagent-surface)", color: "var(--pagent-text)", padding: 8 }}>{theme}</div>
      <p className="harness">{s.harness}</p>
      <p className="server">server: {server}</p>
    </div>
  );
}
`,
      "b/actions.ts": `"use server";\nimport { settings } from "pagent/server";\nexport async function harness() { return settings().harness; }\n`,
    });
    // The same person's other app: one page, so no rail.
    two = await testApp({ "page.tsx": `export const metadata = { title: "Solo" };\nexport default function Solo() { return <p className="solo">solo</p>; }\n` }, { home: one.home });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await two?.close();
    await one?.close();
    mcp?.close();
  });

  const open = async (app: TestApp, path: string, opts: Parameters<Browser["newPage"]>[0] = {}) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light", locale: "en-US", ...opts });
    await page.goto(app.url + path);
    await page.locator(".pagent-top").waitFor();
    return page;
  };
  const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
  const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const file = () => JSON.parse(readFileSync(join(one.home, "settings.json"), "utf8"));

  test("the gear at the bottom of the rail opens them; a change shows in another tab, in another app, in the page frames", async () => {
    const a = await open(one, "/b");
    const a2 = await open(one, "/"); // another tab of the same app
    const b = await open(two, "/"); // a tab of the other app
    await a.locator(".card", { hasText: "light" }).waitFor();
    const light = await bg(a, ".card");

    // In the rail, at its bottom; the app with one page has it in its top bar.
    const gear = a.locator(".pagent-rail .pagent-railfoot .pagent-railgear");
    await gear.waitFor();
    const railBox = (await a.locator(".pagent-rail").boundingBox())!;
    const gearBox = (await gear.boundingBox())!;
    assert.ok(gearBox.y + gearBox.height > railBox.y + railBox.height - 60, "at the bottom of the rail");
    assert.equal(await b.locator(".pagent-rail").count(), 0);
    await b.locator(".pagent-top .pagent-gear").waitFor();

    await gear.click();
    const dialog = a.getByRole("dialog", { name: "Settings" });
    await dialog.waitFor();
    for (const h of ["General", "Agents"]) await dialog.getByRole("heading", { name: h }).waitFor();
    await dialog.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();

    // This tab at once; the file; the other tab and the other app, live.
    await a.locator(".card", { hasText: "dark" }).waitFor();
    assert.equal(await theme(a), "dark");
    assert.notEqual(await bg(a, ".card"), light, "the page frame's colors follow");
    assert.equal(file().theme, "dark");
    await until(async () => (await theme(a2)) === "dark", "the other tab turning dark");
    await until(async () => (await theme(b)) === "dark", "the other app turning dark");
    assert.equal(await bg(b, ".pagent-top"), await bg(a, ".pagent-top"));
    // A reload paints dark from the first frame (this browser remembers what it last heard), then reads the file.
    await b.reload();
    assert.equal(await theme(b), "dark");

    // The language, from the other app's gear: the engine's words of every app follow.
    await b.locator(".pagent-top .pagent-gear").click();
    const bd = b.getByRole("dialog", { name: "Settings" });
    await bd.getByRole("group", { name: "Language" }).getByRole("button", { name: "中文" }).click();
    await b.getByRole("dialog", { name: "设置" }).getByRole("heading", { name: "通用" }).waitFor();
    await a.getByRole("dialog", { name: "设置" }).getByRole("heading", { name: "通用" }).waitFor();
    await a2.locator(".pagent-railgear", { hasText: "设置" }).waitFor();
    assert.equal(file().lang, "zh-CN");
    await b.keyboard.press("Escape");
    assert.equal(await b.getByRole("dialog").count(), 0);

    // The default harness: the pages' useSettings, and server code's settings(), here and in the other tab.
    await a.locator(".harness", { hasText: "claude" }).waitFor();
    await a.locator(".server", { hasText: "server: claude" }).waitFor();
    await a.getByRole("dialog").getByRole("group", { name: "默认 harness" }).getByRole("button", { name: "Codex" }).click();
    await a.locator(".harness", { hasText: "codex" }).waitFor();
    await a.locator(".server", { hasText: "server: codex" }).waitFor();
    const { harnesses, rev: _rev, ...two_ } = await (await fetch(two.url + "/_pagent/settings")).json();
    assert.deepEqual(two_, { lang: "zh-CN", theme: "dark", harness: "codex" });
    assert.deepEqual(harnesses.slice(0, 2), [{ id: "claude", title: "Claude Code" }, { id: "codex", title: "Codex" }], "the engine's runners, each as it names its harness");

    // Back to the defaults: automatic (the browser's: English), the system's theme, Claude Code.
    await a.getByRole("dialog").getByRole("group", { name: "语言" }).getByRole("button", { name: "自动" }).click();
    const ad = a.getByRole("dialog", { name: "Settings" });
    await ad.getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await ad.getByRole("group", { name: "Default harness" }).getByRole("button", { name: "Claude Code" }).click();
    await until(async () => (await theme(b)) === undefined, "the other app back on the system's theme");
    await b.locator(".pagent-top .pagent-gear[aria-label='Settings']").waitFor();
    assert.deepEqual(file(), { harness: "claude" }); // picked: kept as picked (null would leave it to the default)
    await Promise.all([a.close(), a2.close(), b.close()]);
  });

  test("the app's own part, from its home page, in its scope; none for an app whose home page has none", async () => {
    const a = await open(one, "/b");
    await a.locator(".pagent-railgear").click();
    const dialog = a.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("heading", { name: "Notes" }).waitFor(); // the app's name
    await dialog.locator(".app-part input").check();
    await until(() => JSON.parse(readFileSync(join(one.root, "prefs.json"), "utf8")).wrap === true, "the home page's data written");
    const b = await open(two, "/");
    await b.locator(".pagent-gear").click();
    await b.getByRole("dialog", { name: "Settings" }).getByRole("heading", { name: "Agents" }).waitFor();
    assert.equal(await b.getByRole("dialog").locator("[data-part]").count(), 0);
    await Promise.all([a.close(), b.close()]);
  });

  test("a narrow screen: the gear at the bottom of the drawer; the dialog fits", async () => {
    const a = await open(one, "/b", { viewport: { width: 390, height: 760 } });
    await a.locator(".pagent-railbutton").click();
    await a.locator(".pagent-railgear").click();
    const box = (await a.locator(".pagent-settings-box").boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= 390, "within the screen");
    assert.equal(await a.locator(".pagent-rail").count(), 0, "the drawer closed for it");
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    assert.equal(await theme(a), "dark");
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await a.close();
  });

  test("an MCP App (mcp://, another server's page in an iframe) is told the theme, and each change of it", async () => {
    const a = await open(one, "/m");
    const app = a.frameLocator("iframe");
    await app.locator("body[data-theme='light']").waitFor({ state: "attached" });
    await a.locator(".pagent-railgear").click();
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    await app.locator("body[data-theme='dark']").waitFor({ state: "attached" });
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await app.locator("body[data-theme='light']").waitFor({ state: "attached" }); // the system's, in a light browser
    await a.close();
  });

  test("an MCP App still loading when the theme changes is told the theme it is in now", async () => {
    slowImage.asked = false;
    slowImage.gate = new Promise((r) => (slowImage.go = r));
    const a = await open(one, "/slow");
    await until(() => slowImage.asked, "the view to be loading");
    await a.locator(".pagent-railgear").click();
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" }).click();
    await until(async () => (await theme(a)) === "dark", "the page dark");
    slowImage.go(); // the view has loaded: the host connects to it
    await a.frameLocator("iframe").locator("body[data-theme='dark']").waitFor({ state: "attached" });
    await a.getByRole("dialog").getByRole("group", { name: "Theme" }).getByRole("button", { name: "System" }).click();
    await a.close();
  });

  test("a page's first paint is in the settings as they are now, though this browser last heard older ones from this app", async () => {
    const put = (body: unknown) => fetch(one.url + "/_pagent/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const context = await browser.newContext({ colorScheme: "light", locale: "en-US" });
    try {
      const b = await context.newPage();
      await b.goto(two.url + "/");
      await b.locator(".pagent-top").waitFor();
      // What this app's pages last heard: light, the browser's language. Then the person changes them in the other app.
      await b.evaluate(() => localStorage.setItem("pagent.settings", JSON.stringify({ lang: null, theme: "light", harness: "claude" })));
      await put({ theme: "dark", lang: "zh-CN" });
      // Its scripts held back: what paints first is the page as its server sent it.
      await b.route("**/assets/*.js", (r) => r.abort());
      await b.goto(two.url + "/");
      assert.equal(await theme(b), "dark");
      assert.equal(await b.evaluate(() => (window as any).__PAGENT_SETTINGS__.lang), "zh-CN");
      // With them: the engine's words are in its language from the first render, not English for a moment.
      await b.unroute("**/assets/*.js");
      await b.addInitScript(() => {
        new MutationObserver(() => {
          const gear = document.querySelector(".pagent-gear");
          if (gear && !(window as any).__firstGear) (window as any).__firstGear = gear.getAttribute("aria-label");
        }).observe(document, { subtree: true, childList: true });
      });
      await b.goto(two.url + "/");
      await b.locator(".pagent-gear").waitFor();
      assert.equal(await b.evaluate(() => (window as any).__firstGear), "设置");
    } finally {
      await put({ theme: null, lang: null });
      await context.close();
    }
  });

  test("refused: a key that is no setting, a value it does not take (400, nothing written)", async () => {
    const put = (body: unknown) => fetch(one.url + "/_pagent/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await put({ theme: "blue" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /theme is "light", "dark" or null/);
    assert.equal((await put({ font: 3 })).status, 400);
    const { harnesses: _, rev: _rev, ...one_ } = await (await fetch(one.url + "/_pagent/settings")).json();
    assert.deepEqual(one_, { lang: null, theme: null, harness: "claude" });
  });
});

// The view of a tool "show": it asks the host to start (ui/initialize, again until it hears back: the host connects once
// the frame has loaded) and wears the theme the host context says, then each one a change says.
const VIEW = `<!doctype html><body><script>
let n = 0, done = false;
const ask = () => done || (parent.postMessage({ jsonrpc: "2.0", id: ++n, method: "ui/initialize", params: { appInfo: { name: "view", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } }, "*"), setTimeout(ask, 200));
addEventListener("message", ({ data: m }) => {
  if (m?.result?.hostContext && !done) {
    done = true;
    document.body.dataset.theme = m.result.hostContext.theme;
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  }
  if (m?.method === "ui/notifications/host-context-changed" && m.params?.theme) document.body.dataset.theme = m.params.theme;
});
ask();
</script></body>`;

/** The slow view's image: asked for (the view is loading), and sent when the test lets it through. */
const slowImage = { asked: false, go: () => {}, gate: Promise.resolve() };

/**
 * Another server's MCP App, as little of MCP's Streamable HTTP as the shell's client needs: a tool with a view, and one
 * whose view waits for an image (slowImage) before it has loaded.
 */
function mcpApp(): Promise<Server> {
  const answers: Record<string, (p: any) => unknown> = {
    initialize: (p) => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "views", version: "1" } }),
    "tools/list": () => ({ tools: ["show", "slow"].map((name) => ({ name, inputSchema: { type: "object" }, _meta: { ui: { resourceUri: `ui://views/${name}` } } })) }),
    "resources/read": (p) => ({
      contents: [{ uri: p.uri, mimeType: "text/html;profile=mcp-app", text: p.uri.endsWith("/slow") ? VIEW.replace("<body>", `<body><img src="http://127.0.0.1:${(server.address() as AddressInfo).port}/slow.gif">`) : VIEW }],
    }),
    "tools/call": () => ({ content: [{ type: "text", text: "shown" }] }),
  };
  const server = createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, DELETE", "access-control-expose-headers": "*" };
    if (req.method === "GET" && req.url === "/slow.gif") {
      slowImage.asked = true;
      await slowImage.gate;
      return void res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
    }
    if (req.method !== "POST") return void res.writeHead(req.method === "OPTIONS" ? 204 : 405, cors).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const m = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (m.id === undefined) return void res.writeHead(202, cors).end(); // a notification
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: answers[m.method]?.(m.params) ?? {} }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
