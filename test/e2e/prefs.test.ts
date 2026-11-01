// The reader's preferences, in a real browser: one language for the engine's words and the app's own (the reader's
// choice, else the app's metadata.lang, else the browser's), light or dark (setTheme / useTheme: the shell and every
// page follow it: the person's setting, test/e2e/settings.test.ts; else the system's), and the rail's width, dragged by its edge.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakeRunner, testApp, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("the reader's preferences", () => {
  let app: TestApp;
  let browser: Browser;

  before(async () => {
    buildShell();
    app = await testApp({
      // No metadata.lang: the app is read in the browser's language, its own words and the engine's alike.
      "page.tsx": `import { setTheme, useLanguage, useTheme } from "pagent";
export const metadata = { title: "Home" };
export default function Home() {
  const theme = useTheme();
  const chosen = useTheme({ chosen: true });
  const lang = useLanguage();
  return (
    <div>
      <p className="theme">{theme} / {chosen ?? "system"}</p>
      <p className="lang">{lang.startsWith("zh") ? "你好" : "hello"}</p>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme(null)}>system</button>
    </div>
  );
}
`,
      "chat/page.tsx": `import { AgentConsole } from "pagent";
export const metadata = { title: "Chat" };
export const agents = { main: { runner: ${JSON.stringify(fakeRunner)} } };
export default function Chat() { return <AgentConsole inline />; }
`,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  const open = async (path: string, opts: Parameters<Browser["newPage"]>[0] = {}) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...opts });
    await page.goto(app.url + path);
    await page.locator(".pagent-rail").waitFor();
    return page;
  };
  const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

  test("an app that declares no language, in a Chinese browser: its words and the console's in Chinese", async () => {
    const page = await open("/chat", { locale: "zh-CN" });
    await page.getByPlaceholder("输入消息，或输入 / 使用命令").waitFor();
    await page.goto(app.url + "/");
    await page.locator(".lang", { hasText: "你好" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-CN");
    await page.close();
  });

  test("light or dark: the reader's choice, on the shell and the pages, remembered; else the system's", async () => {
    const page = await open("/", { colorScheme: "light" });
    await page.locator(".theme", { hasText: "light / system" }).waitFor();
    const light = await bg(page, ".pagent-rail");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);

    await page.getByRole("button", { name: "dark", exact: true }).click();
    await page.locator(".theme", { hasText: "dark / dark" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    const dark = await bg(page, ".pagent-rail");
    assert.notEqual(dark, light, "the rail turns");
    assert.equal(await bg(page, "body"), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pagent-bg").trim()).then(hexToRgb));

    // Remembered: dark from the first paint after a reload, before the app's code runs.
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    await page.locator(".theme", { hasText: "dark / dark" }).waitFor();
    // Another page of the app, the same.
    await page.goto(app.url + "/chat");
    await page.locator(".pagent-console-inline").waitFor();
    assert.equal(await bg(page, ".pagent-rail"), dark);

    // null: the system's again, which it then follows.
    await page.goto(app.url + "/");
    await page.getByRole("button", { name: "system", exact: true }).click();
    await page.locator(".theme", { hasText: "light / system" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator(".theme", { hasText: "dark / system" }).waitFor();
    assert.equal(await bg(page, ".pagent-rail"), dark);
    // A choice of light holds against a dark system.
    await page.getByRole("button", { name: "light", exact: true }).click();
    await page.locator(".theme", { hasText: "light / light" }).waitFor();
    assert.equal(await bg(page, ".pagent-rail"), light);
    await page.close();
  });

  test("the rail's edge: dragged wider and narrower (within bounds), remembered, double-click resets; no edge on a phone", async () => {
    const page = await open("/");
    const rail = page.locator(".pagent-rail");
    const width = async () => Math.round((await rail.boundingBox())!.width);
    const usual = await width();
    assert.equal(usual, 248);
    const drag = async (dx: number) => {
      const box = (await page.locator(".pagent-railedge").boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + 200;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx / 2, y);
      await page.mouse.move(x + dx, y);
      await page.mouse.up();
    };
    // While it is held: the rail follows the pointer, and nothing is kept until it lets go.
    const stored = () => page.evaluate(() => localStorage.getItem("pagent.rail.width"));
    const edge = page.locator(".pagent-railedge");
    assert.deepEqual(await edge.evaluate((e) => ["aria-valuenow", "aria-valuemin", "aria-valuemax"].map((a) => e.getAttribute(a))), ["248", "180", "480"]);
    {
      const box = (await edge.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 200);
      await page.mouse.down();
      for (let dx = 10; dx <= 60; dx += 10) await page.mouse.move(box.x + box.width / 2 + dx, box.y + 200);
      assert.equal(await width(), 308, "live");
      assert.equal(await edge.getAttribute("aria-valuenow"), "308");
      assert.equal(await stored(), null, "not kept while it is held");
      await page.mouse.up();
      assert.equal(await stored(), "308", "kept when it lets go");
      await drag(-60);
    }
    await drag(100);
    assert.equal(await width(), 348);
    assert.equal(await edge.getAttribute("aria-valuenow"), "348");
    // The page beside it gives way.
    const content = (await page.locator(".pagent-content").boundingBox())!;
    assert.equal(Math.round(content.x), 348);
    await drag(-400);
    assert.equal(await width(), 180, "no narrower than its minimum");
    await drag(1000);
    assert.equal(await width(), 480, "no wider than its maximum");
    await page.reload();
    await rail.waitFor();
    assert.equal(await width(), 480, "remembered");
    // The keyboard moves it too.
    await page.locator(".pagent-railedge").focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await width(), 464);
    await page.keyboard.press("Home");
    assert.equal(await width(), 180, "Home: its narrowest");
    await page.keyboard.press("End");
    assert.equal(await width(), 480, "End: its widest");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await width(), 464);
    await page.locator(".pagent-railedge").dblclick();
    assert.equal(await width(), usual, "its usual width again");
    await page.reload();
    await rail.waitFor();
    assert.equal(await width(), usual);

    // A phone: the rail is a drawer over the page, as wide as ever, with no edge to drag.
    await drag(150);
    assert.equal(await width(), usual + 150);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.locator(".pagent-railbutton").click();
    await rail.waitFor();
    assert.equal(await width(), 300);
    assert.equal(await page.locator(".pagent-railedge").count(), 0);
    await page.close();
  });
});

/** "#151514" → "rgb(21, 21, 20)", as computed styles say a color. */
function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}
