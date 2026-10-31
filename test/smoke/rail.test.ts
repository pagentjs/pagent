// What a page's row in the rail shows besides its title: its icon and its group (metadata.icon, metadata.group, read
// from its code, an instance its page's) and its badge (badge() from the app's server code: a count, a tone, a dot). A
// badge is the node's own state: it is in the pages' list, open pages hear of it, it survives a restart, moves with the
// node and goes with it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { testApp, until, type TestApp } from "../lib/app.ts";

type Page = { path: string; url: string; icon?: string; group?: string; badge?: { count?: number; tone: string } };

describe("the rail: icons and badges", () => {
  let app: TestApp;
  let heard = "";
  const ctl = new AbortController();
  const pages = () => app.get<{ pages: Page[] }>("/_pagent/pages").then((r) => r.pages);
  const page = async (path: string) => (await pages()).find((p) => p.path === path);
  const run = (node: string, name: string, input?: unknown) => app.post<{ ok: boolean; value?: any; error?: string }>("/_pagent/action", { node, name, input });
  const FILM = `<rect x="3" y="5" width="18" height="14" rx="3"/><path class="o" d="M8 5v14"/>`;

  before(async () => {
    app = await testApp({
      "page.tsx": `export const metadata = { title: "Board", icon: '<circle class="d" cx="12" cy="12" r="2"/>' };\nexport default function Home() { return <p>home</p>; }\n`,
      "films/page.tsx": `export const metadata = { title: "Films", group: "Opuscar", icon: ${JSON.stringify(FILM)} };\nexport default function Films() { return <p>films</p>; }\n`,
      // count, tone, path: as badge() takes them; what it gives back, or why it refused.
      "films/actions.ts":
        `"use server";\nimport { badge } from "pagent/server";\n` +
        `export async function mark({ count, tone, path }: { count: number | null; tone?: "attention" | "quiet" | "new"; path?: string }) {\n  return badge(count, { ...(tone ? { tone } : {}), ...(path ? { path } : {}) });\n}\n`,
      "plain/page.tsx": `export default function Plain() { return <p>plain</p>; }\n`,
      "studio/[id]/page.tsx": `export const metadata = { title: "Session", group: "Sessions", icon: '<path class="o" d="M4 12h16"/>' };\nexport default function S() { return <p>s</p>; }\n`,
    });
    void fetch(`${app.url}/_pagent/events`, { signal: ctl.signal })
      .then(async (res) => {
        for await (const chunk of res.body!) heard += Buffer.from(chunk).toString("utf8");
      })
      .catch(() => {});
    await until(() => heard.includes("ping"), "the event stream");
  });
  after(async () => {
    ctl.abort();
    await app.close();
  });

  test("a page's icon and group are in the pages' list, as its code says; an instance has its page's; a page without one has none", async () => {
    await app.get("/_pagent/node?path=/studio/one"); // made by opening it
    assert.equal((await page("/films"))?.icon, FILM);
    assert.equal((await page("/"))?.icon, `<circle class="d" cx="12" cy="12" r="2"/>`);
    assert.equal((await page("/studio/one"))?.icon, `<path class="o" d="M4 12h16"/>`);
    assert.equal((await page("/plain"))?.icon, undefined);
    // Its group, the same way.
    assert.equal((await page("/films"))?.group, "Opuscar");
    assert.equal((await page("/studio/one"))?.group, "Sessions");
    assert.equal((await page("/plain"))?.group, undefined);
  });

  test("badge(): this node's page by default, another's by its path; open pages hear of it; null and 0 clear it", async () => {
    assert.deepEqual((await run("/films", "mark", { count: 4, tone: "attention" })).value, { count: 4, tone: "attention" });
    assert.deepEqual((await page("/films"))?.badge, { count: 4, tone: "attention" });
    await until(() => heard.includes(`"type":"badge","path":"/films","badge":{"count":4,"tone":"attention"}`), "the badge event");
    // The default tone is quiet; another page by its path; a dot alone is "new" without a count.
    assert.deepEqual((await run("/films", "mark", { count: 64, path: "/plain" })).value, { count: 64, tone: "quiet" });
    assert.deepEqual((await run("/films", "mark", { count: null, tone: "new", path: "/" })).value, { tone: "new" });
    assert.deepEqual((await page("/plain"))?.badge, { count: 64, tone: "quiet" });
    assert.deepEqual((await page("/"))?.badge, { tone: "new" });
    // 0 is no count (a count goes in as it is), and null none.
    assert.equal((await run("/films", "mark", { count: 0, path: "/plain" })).value, null);
    assert.equal((await page("/plain"))?.badge, undefined);
    assert.equal((await run("/films", "mark", { count: null, path: "/" })).value, null);
    assert.equal((await page("/"))?.badge, undefined);
    assert.ok(!existsSync(join(app.root, ".state/badge.json")));
  });

  test("what is no badge, or no page, is refused with why", async () => {
    assert.match((await run("/films", "mark", { count: 2.5 })).error ?? "", /a whole number, 0 or more/);
    assert.match((await run("/films", "mark", { count: -1 })).error ?? "", /a whole number, 0 or more/);
    assert.match((await run("/films", "mark", { count: 1, tone: "loud" })).error ?? "", /tone is "attention".*not "loud"/);
    assert.match((await run("/films", "mark", { count: 1, path: "/nowhere" })).error ?? "", /no page at \/nowhere/);
    assert.match((await run("/films", "mark", { count: 1, path: "/studio/never" })).error ?? "", /no page at \/studio\/never/); // an instance not made
    assert.deepEqual((await page("/films"))?.badge, { count: 4, tone: "attention" }); // left as it was
  });

  test("a badge survives a restart, moves with its instance and goes with it", async () => {
    await run("/films", "mark", { count: 7, tone: "new", path: "/studio/one" });
    await app.kill();
    await app.start();
    assert.deepEqual((await page("/films"))?.badge, { count: 4, tone: "attention" });
    assert.deepEqual((await page("/studio/one"))?.badge, { count: 7, tone: "new" });
    await app.post("/_pagent/move", { from: "/studio/one", to: "/studio/two" });
    assert.deepEqual((await page("/studio/two"))?.badge, { count: 7, tone: "new" });
    await app.post("/_pagent/remove", { path: "/studio/two" });
    await app.get("/_pagent/node?path=/studio/two"); // a new one by that name starts without it
    assert.equal((await page("/studio/two"))?.badge, undefined);
  });
});
