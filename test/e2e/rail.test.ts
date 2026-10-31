// The rail as the browser draws it: a page's icon before its title (its shapes as SVG, the current page's in the
// accent), its badge after it (redrawn when server code sets another, no reload), a row without either as it was;
// siblings in a group under its name, groups and rows folded and unfolded (remembered, but never over the page on
// screen; what a fold hides that wants the user still shown); and the rail floated as a panel by tokens alone.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("the rail: icons, badges, groups and folds, a floating panel", () => {
  let app: TestApp;
  let browser: Browser;
  let page: Page;
  const row = (title: string) => page.locator(".pagent-railitem", { has: page.locator(".pagent-railtitle", { hasText: title }) });

  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `export const metadata = { title: "Board" };\nexport default function Home() { return <p>home</p>; }\n`,
      "films/page.tsx": `export const metadata = { title: "Films", icon: '<rect x="3" y="5" width="18" height="14" rx="3"/><path class="o" d="M8 5v14"/>' };\nexport default function Films() { return <p>films page</p>; }\n`,
      "films/actions.ts": `"use server";\nimport { badge } from "pagent/server";\nexport async function mark({ count, tone }: { count: number | null; tone?: "attention" | "quiet" | "new" }) {\n  return badge(count, tone ? { tone } : {});\n}\n`,
      "plain/page.tsx": `export const metadata = { title: "Plain" };\nexport default function Plain() { return <p>plain</p>; }\n`,
      // Two groups of siblings, the second with the lower order first; a row with pages under it.
      "opuscar/page.tsx": `export const metadata = { title: "Opuscar", group: "Open source", order: 5 };\nexport default function P() { return <p>opuscar page</p>; }\n`,
      "opuscar/styles/page.tsx": `export const metadata = { title: "Styles" };\nexport default function P() { return <p>styles page</p>; }\n`,
      "wake/page.tsx": `export const metadata = { title: "Wake", group: "Open source", order: 6 };\nexport default function P() { return <p>wake page</p>; }\n`,
      "studio/page.tsx": `export const metadata = { title: "Studio", group: "Business", order: 2 };\nexport default function P() { return <p>studio page</p>; }\n`,
    });
    await app.post("/_pagent/action", { node: "/films", name: "mark", input: { count: 4, tone: "attention" } });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(app.url + "/films");
    await page.getByText("films page").waitFor();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("an icon: its shapes as SVG before the title, in the accent on the current page; a row without one has none", async () => {
    const icon = row("Films").locator("svg.pagent-railicon");
    await icon.waitFor();
    const drawn = await icon.evaluate((svg) => ({
      shapes: [...svg.children].map((c) => `${c.namespaceURI === "http://www.w3.org/2000/svg" ? "svg:" : ""}${c.tagName}`),
      color: getComputedStyle(svg).color,
      accent: (() => {
        const probe = document.createElement("i");
        probe.style.color = "var(--pagent-accent)";
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      })(),
      openFill: getComputedStyle(svg.querySelector(".o")!).fill,
      width: svg.getBoundingClientRect().width,
    }));
    assert.deepEqual(drawn.shapes, ["svg:rect", "svg:path"]);
    assert.equal(drawn.color, drawn.accent);
    assert.equal(drawn.openFill, "none");
    assert.equal(drawn.width, 16);
    assert.equal(await row("Plain").locator("svg").count(), 0);
  });

  test("a badge after the title, redrawn when server code sets another", async () => {
    const badge = row("Films").locator(".pagent-railbadge");
    await badge.waitFor();
    assert.equal(await badge.textContent(), "4");
    assert.equal(await badge.getAttribute("data-tone"), "attention");
    await app.post("/_pagent/action", { node: "/films", name: "mark", input: { count: null, tone: "new" } });
    await page.waitForFunction(() => document.querySelector(".pagent-railbadge")?.getAttribute("data-tone") === "new");
    assert.equal(await badge.textContent(), "");
    assert.equal(await badge.getAttribute("aria-label"), "Something new");
    await app.post("/_pagent/action", { node: "/films", name: "mark", input: { count: null } });
    await page.waitForFunction(() => !document.querySelector(".pagent-railbadge"));
    assert.equal(await row("Plain").locator(".pagent-railbadge").count(), 0);
  });

  test("groups: siblings in none first, then each group under its name (by its lowest order), no page itself", async () => {
    const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await p.goto(app.url + "/plain");
    await p.getByText("plain", { exact: true }).waitFor();
    const list = () => p.locator(".pagent-raillist").evaluate((l) => [...l.querySelectorAll(".pagent-railtitle, .pagent-railgroupname")].map((e) => e.textContent));
    await until(async () => (await list()).join() === "Films,Plain,Business,Studio,Open source,Opuscar,Styles,Wake", "the groups");
    assert.equal(await p.locator(".pagent-railgroup").first().evaluate((b) => b.tagName + (b.closest("a") ? " in a link" : "")), "BUTTON");
    await p.close();
  });

  test("folds: a group by its name, a row by its chevron (no navigation); remembered in this browser", async () => {
    const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await p.goto(app.url + "/plain");
    await p.getByText("plain", { exact: true }).waitFor();
    const titles = () => p.locator(".pagent-raillist .pagent-railtitle").allTextContents();
    await until(async () => (await titles()).includes("Styles"), "the rows");
    // A row's chevron folds what is under it, and stays on its page.
    const opuscar = p.locator(".pagent-railhead", { has: p.locator('a[href="/opuscar"]') });
    await opuscar.hover();
    const chevron = opuscar.getByRole("button", { name: "Collapse Opuscar" });
    assert.equal(await chevron.getAttribute("aria-expanded"), "true");
    await chevron.click();
    await until(async () => !(await titles()).includes("Styles"), "Styles folded away");
    assert.equal(new URL(p.url()).pathname, "/plain");
    assert.equal(await opuscar.getByRole("button", { name: "Expand Opuscar" }).getAttribute("aria-expanded"), "false");
    // A group by its name, by the keyboard too; folded, it says how many pages it holds.
    const business = p.getByRole("button", { name: "Business" });
    await business.focus();
    await p.keyboard.press("Enter");
    await until(async () => !(await titles()).includes("Studio"), "Studio folded away");
    assert.equal(await business.getAttribute("aria-expanded"), "false");
    assert.equal(await business.locator(".pagent-railcount").textContent(), "1");
    // Remembered in this browser.
    await p.reload();
    await p.getByText("plain", { exact: true }).waitFor();
    await until(async () => (await titles()).includes("Wake"), "the rows again");
    assert.ok(!(await titles()).includes("Studio") && !(await titles()).includes("Styles"));
    await business.click();
    await until(async () => (await titles()).includes("Studio"), "Studio back");
    await p.close();
  });

  test("the group and rows the page on screen is in stay open; what a fold hides that wants the user is on its row", async () => {
    const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await p.goto(app.url + "/plain");
    await p.getByText("plain", { exact: true }).waitFor();
    await p.evaluate(() => localStorage.setItem("pagent.folded", JSON.stringify({ "/#Open source": true, "/opuscar": true })));
    await app.post("/_pagent/badge", { path: "/opuscar/styles", count: 5, tone: "attention" });
    await p.goto(app.url + "/opuscar/styles");
    await p.getByText("styles page").waitFor();
    const titles = () => p.locator(".pagent-raillist .pagent-railtitle").allTextContents();
    await until(async () => {
      const shown = await titles();
      return ["Opuscar", "Styles", "Wake"].every((x) => shown.includes(x));
    }, "the page's group and row open");
    assert.equal(await p.evaluate(() => localStorage.getItem("pagent.folded")), JSON.stringify({ "/#Open source": true, "/opuscar": true })); // as stored
    // Elsewhere, folded as stored; the attention it hides on the group's name.
    await p.locator('a.pagent-railitem[href="/plain"]').click();
    await until(async () => !(await titles()).includes("Opuscar"), "the group folded again");
    const group = p.getByRole("button", { name: /Open source/ });
    assert.equal(await group.locator('.pagent-railfolded .pagent-railbadge[data-tone="attention"]').textContent(), "5");
    await p.close();
  });

  test("floated by tokens: inset from the window's edges, rounded, a window's height less the insets", async () => {
    const rect = () => page.locator(".pagent-rail").evaluate((r) => ({ ...r.getBoundingClientRect().toJSON(), radius: getComputedStyle(r).borderTopLeftRadius }));
    const plain = await rect();
    assert.deepEqual([plain.left, plain.top, plain.height, plain.radius], [0, 0, 800, "0px"]); // as it always was
    await page.addStyleTag({ content: `:root { --pagent-rail-inset: 10px; --pagent-rail-radius: 14px; --pagent-rail-border: transparent; }` });
    const floating = await rect();
    assert.deepEqual([floating.left, floating.top, floating.height, floating.radius], [10, 10, 780, "14px"]);
  });
});
