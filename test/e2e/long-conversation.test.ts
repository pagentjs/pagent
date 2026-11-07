// A long conversation (an agent many turns in, 2026-11-06: 2000 messages, 8 MB, every one rendered at once) shows its
// latest turns; the earlier ones come in as the reader scrolls up to them, above what they were reading, which stays
// where it was. What is folded (a tool call's card) is rendered once it is opened.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakeRunner, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const TURNS = 200; // the view's first part is 80 (VIEW_TURNS in the bridge's chat)

describe("a long conversation", () => {
  let app: TestApp;
  let browser: Browser;
  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `import { AgentConsole } from "pagent";
export const agents = { bot: { runner: ${JSON.stringify(fakeRunner)} } };
export default function Page() { return <AgentConsole inline />; }
`,
    });
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say turn 0 done" }); // the transcript is there
    const at = new Date().toISOString();
    const lines: string[] = [];
    for (let i = 1; i <= TURNS; i++) {
      lines.push(JSON.stringify({ uuid: `u${i}`, type: "user", text: `turn ${i}`, at }));
      lines.push(JSON.stringify({ uuid: `a${i}`, type: "assistant", text: `turn ${i} done`, at }));
    }
    appendFileSync(join(app.root, ".state", "bot", "transcript.jsonl"), lines.join("\n") + "\n");
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("the latest turns, then earlier ones as the reader scrolls up, without moving what they read", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const asked: string[] = [];
    page.on("request", (r) => r.url().includes("/_pagent/history") && asked.push(new URL(r.url()).search));
    await page.goto(app.url + "/");
    const log = page.locator(".pagent-console-log");
    const said = (n: number) => log.locator(".pagent-turn.pagent-assistant", { hasText: new RegExp(`^turn ${n} done$`) });
    await said(TURNS).waitFor();
    assert.equal(await said(TURNS - 79).count(), 1, "80 turns");
    assert.equal(await said(TURNS - 80).count(), 0, "not the ones before");
    // Before them: turn 0 (its message and reply) and turns 1 to 120.
    const earlier = page.locator(".pagent-earlier button");
    assert.equal(await earlier.innerText(), `Earlier: ${2 + 2 * (TURNS - 80)} messages`);
    assert.ok(asked.every((q) => q.includes("last=80")), "a view asks for its part");

    // The reader scrolls up: near the top, the 80 before come in above, and what they were reading does not jump.
    await log.hover();
    const fromEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop);
    for (let i = 0; i < 100 && !(await said(TURNS - 80).count()); i++) await page.mouse.wheel(0, -2000), await page.waitForTimeout(50);
    await said(TURNS - 80).waitFor();
    assert.equal(await said(TURNS - 159).count(), 1);
    const kept = await fromEnd();
    await page.waitForTimeout(500);
    assert.ok(Math.abs((await fromEnd()) - kept) < 5, "still where it was once they are in");
    assert.ok((await log.evaluate((el) => el.scrollTop)) > 1000, "not thrown to the top of what came in");
    assert.equal(await earlier.innerText(), `Earlier: ${2 + 2 * (TURNS - 160)} messages`);

    // The last of them, by its button (scrolled to, as the reader would); then nothing more before.
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    await earlier.click();
    await said(1).waitFor();
    await said(0).waitFor();
    assert.equal(await earlier.count(), 0);
    assert.equal(await log.locator(".pagent-turn.pagent-assistant").count(), TURNS + 1, "each once");
    await page.close();
  });

  test("a turn after the reader loaded earlier ones: they stay, the new one comes in at the end", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(app.url + "/");
    const log = page.locator(".pagent-console-log");
    await log.locator(".pagent-turn", { hasText: `turn ${TURNS} done` }).waitFor();
    await page.locator(".pagent-earlier button").click();
    await log.locator(".pagent-turn", { hasText: /^turn 41 done$/ }).waitFor();
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: "!say the newest" });
    await log.locator(".pagent-turn.pagent-assistant", { hasText: "the newest" }).waitFor();
    // The history read again (the turn's end): from the first shown on.
    await page.waitForTimeout(1200);
    assert.equal(await log.locator(".pagent-turn", { hasText: /^turn 41 done$/ }).count(), 1, "the earlier ones loaded are still there");
    assert.equal(await log.locator(".pagent-turn.pagent-assistant", { hasText: "the newest" }).count(), 1);
    await page.close();
  });

  test("a tool call's card renders what it holds once opened, fetching the call whole", async () => {
    await app.post("/_pagent/ask", { node: "/", agent: "bot", message: `!tool Write ${JSON.stringify({ file_path: "/tmp/a.txt", content: "y".repeat(9000) })}\n!say wrote it` });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(app.url + "/");
    const log = page.locator(".pagent-console-log");
    await log.locator(".pagent-turn.pagent-assistant", { hasText: "wrote it" }).waitFor();
    const steps = log.locator(".pagent-steps").last();
    assert.equal(await steps.locator(".pagent-toolcard").count(), 0, "shut: not rendered");
    await steps.locator("summary").first().click();
    const card = steps.locator(".pagent-toolcard");
    await card.locator("summary").click();
    // The history has a few lines of it; opened, the card has the call as it is.
    await until(async () => (await card.locator("pre").first().innerText()).includes("y".repeat(9000)), "the call whole");
    assert.doesNotMatch(await card.locator("pre").first().innerText(), /more characters/);
    await page.close();
  });
});
