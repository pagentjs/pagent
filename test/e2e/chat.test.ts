// A conversation in a real browser (Playwright, headless Chromium) against a real server, the agent on the fake runner.
// Each reply is shown once, and stays the same element on the page from its first word to well after the turn: the
// history that loads later (the transcript's ids) must not add it again, nor mount it again (a card in it would lose
// its state, and the refs `pagent screen read` gave out).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const status = (app: TestApp) => app.get("/_pagent/agent-status?node=/&agent=bot");
const idle = (app: TestApp) => until(async () => !(await status(app)).busy, "the agent to be idle");

/** Watch the conversation: how many replies contain `text` at most, at any moment; and whether the first one stays. */
async function watch(page: Page, text: string) {
  await page.evaluate((text) => {
    const w = window as any;
    w.__max = 0;
    w.__first = null;
    w.__replaced = false;
    const check = () => {
      const turns = [...document.querySelectorAll(".pagent-turn.pagent-assistant")].filter((t) => t.textContent?.includes(text));
      w.__max = Math.max(w.__max, turns.length);
      if (!w.__first && turns[0]) w.__first = turns[0];
      if (w.__first && !w.__first.isConnected) w.__replaced = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    check();
  }, text);
  return async () => page.evaluate(() => ({ max: (window as any).__max as number, replaced: (window as any).__replaced as boolean, seen: !!(window as any).__first }));
}

describe("a conversation in the browser", () => {
  let app: TestApp;
  let browser: Browser;
  const logs: string[] = [];
  const state = () => join(app.root, ".state", "bot");

  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `import { Chat } from "pagent";\n` + fakePage({ bot: {} }, `<Chat />`),
      // A console and the plan beside it, of the same agent: one conversation between them.
      "plan/page.tsx":
        `import { AgentConsole, usePlan } from "pagent";\n` +
        `function Steps() { const p = usePlan(); return <p className="plan-steps">{p.loaded ? \`steps: \${p.steps?.length ?? 0}\` : "…"}</p>; }\n` +
        fakePage({ bot: {} }, `<div><Steps /><AgentConsole inline /></div>`),
    });
    browser = await chromium.launch();
  });
  after(async () => {
    if (process.env.PAGENT_E2E_LOG) console.log(logs.join("\n"));
    await browser?.close();
    await app?.close();
  });

  const open = async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("pagent:debug", "chat"));
    page.on("console", (m) => m.type() === "debug" && logs.push(m.text()));
    await page.goto(app.url + "/");
    await page.locator(".pagent-chat textarea").waitFor();
    return page;
  };
  const send = async (page: Page, text: string) => {
    await page.locator(".pagent-chat textarea").fill(text);
    await page.keyboard.press("Enter");
  };
  /** One turn from the chat, watched from its first word until well after it ended (the history loads it causes). */
  const turn = async (page: Page, n: number) => {
    const seen = await watch(page, `part 1 of ${n}.`);
    await send(page, `!slow ${n} 300`);
    await until(async () => (await seen()).seen, "the reply to show");
    await idle(app);
    await page.waitForTimeout(2000); // the transcript watcher's history event (after 500 ms), and the load it causes
    const r = await seen();
    assert.equal(r.max, 1, "shown more than once");
    assert.equal(r.replaced, false, "the reply was mounted again");
    assert.equal(await page.locator(".pagent-turn.pagent-assistant", { hasText: `part 1 of ${n}.` }).count(), 1);
    assert.equal(await page.locator(".pagent-turn.pagent-user", { hasText: `!slow ${n} 300` }).count(), 1);
  };

  test("replies typed in the chat: each shown once, never mounted again", async () => {
    // A turn before: its transcript is there when the page reads the history, so the server watches it, and the end of
    // each turn below makes the page load the history again.
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say before" });
    const page = await open();
    await page.locator(".pagent-turn.pagent-assistant", { hasText: "before" }).waitFor(); // the history is there
    await turn(page, 3);
    await turn(page, 4);
    await page.close();
  });

  test("a message sent before the history arrived", async () => {
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say something new" }); // so the history is read again
    writeFileSync(join(state(), "slow-history"), "1500");
    try {
      const page = await open();
      await turn(page, 2);
      assert.equal(await page.locator(".pagent-turn.pagent-assistant", { hasText: "something new" }).count(), 1);
      await page.close();
    } finally {
      rmSync(join(state(), "slow-history"));
    }
  });

  test("a page opened in the middle of a turn shows that turn once", async () => {
    void app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!slow 8 300" });
    const transcript = join(state(), "transcript.jsonl");
    await until(() => existsSync(transcript) && readFileSync(transcript, "utf8").includes("part 2 of 8."), "the turn to be half written");
    assert.equal((await status(app)).busy, true);
    const page = await open();
    const seen = await watch(page, "part 1 of 8.");
    await idle(app);
    await page.waitForTimeout(2000);
    const r = await seen();
    assert.equal(r.max, 1, "shown more than once");
    assert.equal(r.replaced, false, "the reply was mounted again");
    assert.equal(await page.locator(".pagent-turn.pagent-user", { hasText: "!slow 8 300" }).count(), 1);
    await page.close();
  });

  test("a card of the page the conversation is on is a link, not that page (and its conversation) again", async () => {
    mkdirSync(join(app.root, "cards", "hello"), { recursive: true });
    writeFileSync(join(app.root, "cards", "hello", "page.tsx"), `export default function Hello() { return <p className="hello-card">hello card</p>; }\n`);
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!card /cards/hello\n!card /" });
    const page = await open();
    await page.locator(".hello-card").waitFor();
    await page.locator("[data-pagent-card-loop]").waitFor();
    await page.waitForTimeout(1000); // anything nested would have rendered by now
    assert.equal(await page.locator(".pagent-card").count(), 2, "one card each: the page itself was not shown inside itself");
    assert.equal(await page.locator(".pagent-chat").count(), 1, "one conversation on the page");
    assert.equal(await page.locator("[data-pagent-card-loop] a").getAttribute("href"), "/");
    await page.close();
  });

  test("an agent's markdown loads nothing on its own: another site's image is a link to it; //host is no page of the app", async () => {
    const seen: string[] = [];
    const pixel = createServer((req, res) => (seen.push(req.url ?? ""), res.writeHead(200, { "content-type": "image/gif" }).end(GIF)));
    await new Promise<void>((r) => pixel.listen(0, "127.0.0.1", r));
    const other = `http://127.0.0.1:${(pixel.address() as AddressInfo).port}`;
    try {
      const md = [
        `![leak](${other}/p.gif?d=secret) ![](//127.0.0.1:${(pixel.address() as AddressInfo).port}/q.gif)`,
        `![own](${app.url}/_pagent/nothing.gif) ![dot](data:image/gif;base64,${GIF.toString("base64")})`,
        `[away](//localhost/x) [home](/) [file](/Users/sam/notes.md)`,
      ].join("\n\n");
      await app.post("/_pagent/ask", { node: "/", agent: "bot", message: md.split("\n\n").map((l) => `!say ${l}`).join("\n") });
      const page = await open();
      const reply = page.locator(".pagent-turn.pagent-assistant", { hasText: "leak" }).last();
      await reply.waitFor();
      // Another site's: a link (its words and its address), no request to it.
      const link = reply.locator("a.pagent-imagelink-out", { hasText: "leak" });
      assert.equal(await link.getAttribute("href"), `${other}/p.gif?d=secret`);
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match((await link.textContent()) ?? "", /leak: http:\/\/127\.0\.0\.1:\d+\/p\.gif\?d=secret/);
      assert.equal(await reply.locator("a.pagent-imagelink-out").count(), 2, "the scheme-relative one too");
      // The app's own and one in the text: images.
      assert.equal(await reply.locator(`img[alt="own"]`).getAttribute("src"), `${app.url}/_pagent/nothing.gif`);
      assert.match((await reply.locator(`img[alt="dot"]`).getAttribute("src")) ?? "", /^data:image\/gif;base64,/);
      // "//localhost/x" is another site: code, not a link in place; "/" is the app's; a file's path is code.
      assert.equal(await reply.locator("code", { hasText: "away" }).count(), 1);
      assert.equal(await reply.locator("a", { hasText: "home" }).getAttribute("href"), "/");
      assert.equal(await reply.locator("code", { hasText: "file" }).count(), 1);
      await page.waitForTimeout(500);
      assert.deepEqual(seen, [], "nothing asked of the other site");
      await page.close();
    } finally {
      pixel.close();
    }
  });

  test("a console and usePlan of the same agent on one page: one history read, one stream per turn", async () => {
    const page = await browser.newPage();
    const asked: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (/^\/_pagent\/(history|chat)/.test(u.pathname)) asked.push(`${r.method()} ${u.pathname}`);
    });
    await page.goto(app.url + "/plan");
    await page.locator(".plan-steps", { hasText: "steps: 0" }).waitFor();
    await page.waitForTimeout(500);
    assert.deepEqual(asked.filter((a) => a.startsWith("GET /_pagent/history")), ["GET /_pagent/history"], "the history read once");
    assert.ok(asked.filter((a) => a.startsWith("GET /_pagent/chat/stream")).length <= 1, asked.join(", "));
    asked.length = 0;
    const todos = JSON.stringify({ todos: [{ content: "Read", status: "in_progress", activeForm: "Reading" }, { content: "Fix", status: "pending", activeForm: "Fixing" }] });
    await page.locator(".pagent-console textarea").fill(`!tool TodoWrite ${todos}\n!say done`);
    await page.keyboard.press("Enter");
    await page.locator(".plan-steps", { hasText: "steps: 2" }).waitFor();
    await page.locator(".pagent-turn.pagent-assistant", { hasText: "done" }).waitFor();
    await until(async () => !(await app.get("/_pagent/agent-status?node=/plan&agent=bot")).busy, "the agent to be idle");
    await page.waitForTimeout(500);
    assert.equal(asked.filter((a) => a === "POST /_pagent/chat").length, 1);
    assert.deepEqual(asked.filter((a) => a.startsWith("GET /_pagent/chat/stream")), [], "the turn streamed once, to the one conversation that sent it");

    // A call that adds or changes one step is a line in its card, not a list of one nor its JSON; the whole list is a list.
    await page.locator(".pagent-console textarea").fill(`!tool TaskCreate {"subject":"Ship it"}\n!tool TaskUpdate {"taskId":"3","status":"completed"}\n!tool TaskUpdate {"taskId":"2","status":"deleted"}\n!say all set`);
    await page.keyboard.press("Enter");
    await page.locator(".pagent-turn.pagent-assistant", { hasText: "all set" }).waitFor();
    // The turn over, and the conversation read again after it (its steps as the history has them).
    await until(async () => !(await app.get("/_pagent/agent-status?node=/plan&agent=bot")).busy, "the agent to be idle");
    await page.waitForTimeout(1000);
    // Steps, shut, are rendered once opened (both turns').
    for (const summary of await page.locator(".pagent-steps > summary").all()) await summary.click();
    await until(async () => (await page.locator(".pagent-toolcard").count()) === 4, "the cards rendered");
    const briefs = await page.locator(".pagent-toolcard .pagent-toolcard-brief").allTextContents();
    assert.deepEqual(briefs, ["0 of 2 done", "new step: Ship it", "step 3: done", "step 2: removed"]);
    const cards = page.locator(".pagent-toolcard");
    for (const i of [0, 1, 2, 3]) await cards.nth(i).locator("summary").click();
    await cards.nth(0).locator(".pagent-steplist").waitFor();
    assert.equal(await cards.nth(0).locator(".pagent-steplist li").count(), 2);
    for (const i of [1, 2, 3]) assert.equal(await cards.nth(i).locator("pre, .pagent-steplist").count(), 0, "no JSON, no list");
    // Each step's state is words for a screen reader, not a label on an element without a role.
    assert.deepEqual(await cards.nth(0).locator(".pagent-steplist li").evaluateAll((li) => li.map((l) => l.textContent)), ["under way: Reading", "to do: Fix"]);
    assert.equal(await page.locator(".pagent-steplist-mark[aria-label]").count(), 0);
    await page.close();
  });
});

/** A 1×1 GIF. */
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
