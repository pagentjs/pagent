// What the console says about an agent's terminal (the fake runner with a TUI): a dialog in it nobody sees, as a card
// with its choices; turns running without it, as its TUI did not come up, and why; a TUI running a declaration that
// changed since, with a button that restarts it.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { fakeTuiRunner, testApp, until, type TestApp } from "../lib/app.ts";
import { buildShell } from "../lib/shell.ts";

const page = (agents: Record<string, Record<string, unknown>>) =>
  `import { AgentConsole } from "pagent";\nexport const agents = ${JSON.stringify(agents)};\nexport default function Page() { return <AgentConsole inline />; }\n`;

describe("the console about its agent's terminal", () => {
  let app: TestApp;
  let browser: Browser;
  const status = (node: string) => app.get(`/_pagent/agent-status?node=${node}&agent=bot`);
  before(async () => {
    buildShell();
    app = await testApp(
      {
        "dialog/page.tsx": page({ bot: { runner: fakeTuiRunner } }),
        "stuck/page.tsx": page({ bot: { runner: fakeTuiRunner, asks: "[oh-my-zsh] Would you like to update? [Y/n]" } }),
        "model/page.tsx": page({ bot: { runner: fakeTuiRunner, model: "a" } }),
      },
      { env: { PAGENT_TUI_UP_MS: "1000" } },
    );
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await app?.close();
  });

  test("a dialog in its unseen terminal: a card with its choices; one is pressed there", async () => {
    const p = await browser.newPage();
    await p.goto(app.url + "/dialog");
    const reply = app.post("/_pagent/ask", { node: "/dialog", agent: "bot", message: "!dialog We recommend compacting earlier|Autocompact at 400k tokens|Keep 1M" });
    const card = p.locator(".pagent-console .pagent-question", { hasText: "Waiting in its terminal: We recommend compacting earlier" });
    await card.waitFor();
    assert.match(await card.locator(".pagent-question-eyebrow").innerText(), /bot is stuck on a dialog in its terminal/);
    assert.deepEqual(await card.locator(".pagent-question-options button").allInnerTexts(), ["Autocompact at 400k tokens", "Keep 1M", "Dismiss (Esc)"]);
    await card.getByRole("button", { name: "Keep 1M" }).click();
    assert.equal((await reply).text, "chose Keep 1M");
    await card.waitFor({ state: "detached" });
    await p.close();
  });

  test("its TUI did not come up: the console says it works without it, and why", async () => {
    const p = await browser.newPage();
    await p.goto(app.url + "/stuck");
    assert.equal((await app.post("/_pagent/ask", { node: "/stuck", agent: "bot", message: "!say headless" })).text, "headless");
    const note = p.locator('.pagent-console-note[data-kind="headless"]');
    await note.waitFor();
    assert.match(await note.innerText(), /^Working without its terminal for now \(it did not say it was up within 1 s; its screen showed: "\[oh-my-zsh\] Would you like to update\? \[Y\/n\]"\), so a message waits for its turn to end\. Its terminal is tried again in \d+ min, or when you open it\.$/);
    await p.close();
  });

  test("its declaration changed: the console says so, and Restart now restarts its terminal", async () => {
    const p = await browser.newPage();
    await p.goto(app.url + "/model");
    await app.post("/_pagent/ask", { node: "/model", agent: "bot", message: "!say up" }); // its TUI is open
    writeFileSync(join(app.root, "model", "page.tsx"), page({ bot: { runner: fakeTuiRunner, model: "b" } }));
    const note = p.locator('.pagent-console-note[data-kind="stale"]');
    await note.waitFor();
    assert.match(await note.innerText(), /Its settings changed since its terminal started/);
    await note.getByRole("button", { name: "Restart now" }).click();
    await note.waitFor({ state: "detached" });
    await until(async () => (await status("/model")).terminal.stale === undefined, "the TUI to be current");
    await p.close();
  });
});
