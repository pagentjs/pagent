// A page opened before pagent was updated runs the shell it loaded then. The server says on the event stream which shell
// it serves now; a page running another loads the new one (an old shell met a new kind of sender and crashed a
// conversation, 2026-11-06), and one running the same stays as it is.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakePage, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("a page and the shell the server serves", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({ "page.tsx": fakePage({ bot: {} }, `<p>the page</p>`) });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("the stream says the build first: the entry script index.html loads", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${app.url}/_pagent/events`, { signal: ctl.signal });
    let heard = "";
    for await (const chunk of res.body!) {
      heard += Buffer.from(chunk).toString("utf8");
      if (heard.includes("event: shell")) break;
    }
    ctl.abort();
    const index = await (await fetch(`${app.url}/`)).text();
    const entry = /\/assets\/index-[\w-]+\.js/.exec(index)![0];
    assert.match(heard, new RegExp(`event: shell\\ndata: \\{"id":"${entry.replace(/[.]/g, "\\.")}"\\}`));
  });

  test("a page on another build reloads; on the same, it stays", async () => {
    const page = await browser.newPage();
    // The stream as a server would send it after an update: another build. Once: the reload gets the real stream.
    let served = 0;
    await page.route("**/_pagent/events*", async (route) => {
      if (served++) return route.continue();
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: 'event: ping\ndata: {}\n\nevent: shell\ndata: {"id":"/assets/index-newer.js"}\n\n' });
    });
    await page.goto(`${app.url}/`);
    await page.locator("text=the page").waitFor();
    await page.waitForFunction(() => performance.getEntriesByType("navigation").length > 0);
    // Reloaded: the navigation after the first, on the real stream (which says this build: no more reloads).
    await page.waitForFunction(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type === "reload", undefined, { timeout: 15_000 });
    await page.locator("text=the page").waitFor();
    await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
    await page.waitForTimeout(2000);
    assert.equal(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed), true, "the page on the build served stays");
    assert.ok(served >= 2);
    await page.close();
  });
});
