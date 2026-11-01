// A message queued in the console while the agent works waits on the server, not in the page (a
// user found it gone after switching pages and back: "a fake queue"): going to another page and back, it is still there, another tab shows it
// too, and the agent gets it once its turn is done; withdrawn (×) in one tab, it goes from both and never arrives.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { fakeRunner, lines, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

describe("queued in the console, kept on the server", () => {
  let app: TestApp;
  let browser: Browser;
  const status = () => app.get("/_pagent/agent-status?node=/&agent=bot");
  const history = async () => lines((await app.get("/_pagent/history?node=/&agent=bot")).messages);
  // A turn that goes on until the test says (a file "go" in the app's folder).
  const held = (said: string) => app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message: `!sh while [ ! -f go ]; do sleep 0.1; done; echo held\n!say ${said}` });
  const go = () => writeFileSync(join(app.root, "go"), "");

  before(async () => {
    buildShell();
    app = await testApp({
      "page.tsx": `import { AgentConsole, navigate } from "pagent";
export const agents = { bot: { runner: ${JSON.stringify(fakeRunner)} } };
export default function Home() {
  return (
    <div>
      <button className="away" onClick={() => navigate("/other")}>elsewhere</button>
      <AgentConsole inline />
    </div>
  );
}
`,
      "other/page.tsx": `import { navigate } from "pagent";
export default function Other() {
  return <button className="back" onClick={() => navigate("/")}>back</button>;
}
`,
    });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  /** The page at the console, once its status says the agent is busy. */
  async function busyConsole(p: Page) {
    await p.goto(app.url + "/");
    const box = p.locator(".pagent-console textarea");
    await until(async () => (await box.getAttribute("placeholder")) === "Queue a message for when it's done", "the busy placeholder");
    return box;
  }

  test("queued, to another page and back: still there, in another tab too, and the agent gets it after its turn", async () => {
    rmSync(join(app.root, "go"), { force: true });
    const first = held("first");
    await until(async () => (await status()).busy, "the first turn");
    const p = await browser.newPage();
    const box = await busyConsole(p);
    await box.fill("!say queued one");
    await box.press("Enter");
    const item = (page: Page) => page.locator(".pagent-queued-item", { hasText: "!say queued one" });
    await item(p).waitFor();

    // Away (the console is gone) and back.
    await p.locator("button.away").click();
    await p.locator("button.back").waitFor();
    assert.equal(await p.locator(".pagent-console").count(), 0);
    await p.locator("button.back").click();
    await item(p).waitFor();

    // Another tab, and this one reloaded, show it too.
    const other = await browser.newPage();
    await other.goto(app.url + "/");
    await item(other).waitFor();
    await p.reload();
    await item(p).waitFor();
    assert.equal((await status()).queued.length, 1);

    go();
    assert.equal((await first).text, "held\n\nfirst");
    for (const page of [p, other]) {
      await item(page).waitFor({ state: "detached" });
      await page.locator(".pagent-console-log .pagent-turn.pagent-assistant", { hasText: "queued one" }).waitFor();
      // Once, after the turn it waited for.
      const said = await page.locator(".pagent-console-log .pagent-turn").allTextContents();
      assert.equal(said.filter((s) => s.includes("!say queued one")).length, 1);
      assert.ok(said.findIndex((s) => s.includes("!say queued one")) > said.findIndex((s) => s.includes("first")));
    }
    await until(async () => !(await status()).busy, "the queued turn to end");
    assert.deepEqual((await history()).slice(-2), ["user: !say queued one", "assistant: queued one"]);
    await p.close();
    await other.close();
  });

  test("withdrawn in one tab: gone from both, and the agent never gets it", async () => {
    rmSync(join(app.root, "go"), { force: true });
    const first = held("second");
    await until(async () => (await status()).busy, "the turn");
    const [p, other] = [await browser.newPage(), await browser.newPage()];
    const box = await busyConsole(p);
    await busyConsole(other);
    await box.fill("!say never sent");
    await box.press("Enter");
    const item = (page: Page) => page.locator(".pagent-queued-item", { hasText: "!say never sent" });
    await item(other).waitFor();
    await item(p).getByRole("button", { name: "Remove" }).click();
    await item(p).waitFor({ state: "detached" });
    await item(other).waitFor({ state: "detached" });
    assert.deepEqual((await status()).queued, []);

    go();
    assert.equal((await first).text, "held\n\nsecond");
    await until(async () => !(await status()).busy, "the turn to end");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await status()).busy, false, "nothing after it");
    assert.ok(!(await history()).some((l) => l.includes("never sent")));
    await p.close();
    await other.close();
  });
});
