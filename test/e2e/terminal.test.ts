// <Terminal> in a real browser: it opens the agent's TUI only once the agent's status says its harness has one. Before
// that it is a guess (nothing of the session known), and opening on it would start a socket and a process, and for a
// harness without a TUI show an error for a moment.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("<Terminal>", () => {
  let app: TestApp;
  let browser: Browser;

  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": `import { Terminal } from "pagent";\n` + fakePage({ bot: {} }, `<Terminal style={{ height: 300 }} />`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  /** The page, its agent's status held back until `release()` (and changed by `edit`); the sockets it opened. */
  async function open(edit: (status: any) => any = (s) => s) {
    const page = await browser.newPage();
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(new URL(ws.url()).pathname));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/_pagent/agent-status?*", async (route) => {
      await held;
      const res = await route.fetch();
      await route.fulfill({ response: res, json: edit(await res.json()) });
    });
    // Whether a terminal was ever on the page.
    await page.addInitScript(() => {
      new MutationObserver(() => document.querySelector(".pagent-terminal") && ((window as any).__terminal = true)).observe(document, { subtree: true, childList: true });
    });
    await page.goto(app.url + "/");
    await page.locator(".pagent-terminal-wait").waitFor({ state: "attached" });
    return { page, sockets, release };
  }
  const ever = (page: Page) => page.evaluate(() => !!(window as any).__terminal);

  test("its harness has a TUI: nothing until the status says so, then the terminal", async () => {
    const { page, sockets, release } = await open();
    await page.waitForTimeout(800);
    assert.equal(await ever(page), false, "no terminal on a guess");
    assert.deepEqual(sockets, []);
    release();
    await page.locator(".pagent-terminal").waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(sockets, ["/_pagent/terminal"]);
    assert.equal(await page.locator(".pagent-terminal-wait").count(), 0);
    await page.close();
  });

  test("its harness has none: it says so, and never opened a terminal", async () => {
    const { page, sockets, release } = await open((s) => ({ ...s, session: { ...s.session, harness: { id: "quiet", title: "Quiet CLI" }, can: { ...s.session.can, terminal: false } } }));
    await page.waitForTimeout(500);
    release();
    await page.getByText("Quiet CLI").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await ever(page), false);
    assert.deepEqual(sockets, []);
    await page.close();
  });
});
