// nodes.make (pagent/server): an instance of a dynamic page made by server code, with data files in it from the start.
// Its agents function already reads them: what it returned before the instance was made (only asked whether the params
// are the page's) is not kept, so a choice made with the instance (here, which harness) holds from its first turn, and
// after a restart, while one made without it keeps what the function decided then.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeRunner, testApp, type TestApp } from "../lib/app.ts";

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("nodes.make", () => {
  let app: TestApp;
  const open = (path: string) => app.get<{ manifest: { agents: { name: string }[]; errors: string[] } }>(`/_pagent/node?${qs({ path })}`);
  const agentsOf = async (path: string) => (await open(path)).manifest.agents.map((a) => a.name);
  const action = (name: string, input: unknown) =>
    app.post<{ ok: boolean; value?: any; error?: string }>("/_pagent/action", { node: "/w", name, input, from: "/w" });

  before(async () => {
    app = await testApp({
      "page.tsx": `export default function Home() { return <p>home</p>; }\n`,
      // The default, in the app's data; an instance's own choice, in its folder: its agent is named after it.
      "settings.json": `{ "harness": "claude" }\n`,
      "w/[id]/page.tsx":
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { node } from "pagent/server";\n` +
        `export function agents({ params }) {\n` +
        `  if (params.id === "nope") return null;\n` +
        `  const own = join(node.dir, "harness.json");\n` +
        `  let harness = existsSync(own) ? JSON.parse(readFileSync(own, "utf8")).harness : null;\n` +
        `  if (!harness) {\n` +
        `    harness = JSON.parse(readFileSync(join(node.root, "settings.json"), "utf8")).harness;\n` +
        `    if (existsSync(node.dir)) writeFileSync(own, JSON.stringify({ harness }), { flag: "wx" });\n` +
        `  }\n` +
        `  return { [harness]: { runner: ${JSON.stringify(fakeRunner)} } };\n` +
        `}\n` +
        `export default function S() { return <p>session</p>; }\n`,
      "w/page.tsx": `export default function W() { return <p>sessions</p>; }\n`,
      "w/actions.ts":
        `"use server";\nimport { nodes } from "pagent/server";\n` +
        `export async function make({ id, data }) { return nodes.make("/w/" + id, data ? { data } : {}); }\n`,
    });
  });
  after(() => app.close());

  test("made with data: its agents function reads it from the first time it counts", async () => {
    // Looked at before it is made (as a page that is not there is): that answer is not kept.
    assert.match((await app.get<{ error?: string }>(`/_pagent/node?${qs({ path: "/w/one", again: "1" })}`).catch((e: Error) => ({ error: e.message }))).error ?? "", /not there/);
    const r = await action("make", { id: "one", data: { "harness.json": { harness: "codex" }, "notes.md": "# one\n" } });
    assert.ok(r.ok, r.error ?? "made");
    assert.equal(r.value.path, "/w/one");
    assert.equal(r.value.url, "/w/one");
    assert.deepEqual(r.value.params, { id: "one" });
    assert.equal(r.value.createdBy, "/w", "made by whom the code runs for: the page that called it");
    assert.equal(typeof r.value.createdAt, "number");
    assert.deepEqual(JSON.parse(readFileSync(join(app.root, "w/one/harness.json"), "utf8")), { harness: "codex" });
    assert.equal(readFileSync(join(app.root, "w/one/notes.md"), "utf8"), "# one\n");
    assert.deepEqual(await agentsOf("/w/one"), ["codex"]);
    // Its agent answers under that name.
    const said = await app.post<{ text: string }>("/_pagent/ask", { node: "/w/one", agent: "codex", message: "hi" });
    assert.match(said.text, /hi/);
  });

  test("made without: what its agents function decided when it was made holds, after the default changes and a restart", async () => {
    const r = await action("make", { id: "two" });
    assert.ok(r.ok, r.error ?? "made");
    assert.deepEqual(await agentsOf("/w/two"), ["claude"]);
    assert.deepEqual(JSON.parse(readFileSync(join(app.root, "w/two/harness.json"), "utf8")), { harness: "claude" });
    writeFileSync(join(app.root, "settings.json"), `{ "harness": "codex" }\n`);
    await app.kill();
    await app.start();
    assert.deepEqual(await agentsOf("/w/two"), ["claude"]);
    assert.deepEqual(await agentsOf("/w/one"), ["codex"]);
    // Opening a new one now (the rail's "+"): the default of now.
    assert.deepEqual(await agentsOf("/w/three"), ["codex"]);
    assert.deepEqual(JSON.parse(readFileSync(join(app.root, "w/three/harness.json"), "utf8")), { harness: "codex" });
  });

  test("errors: one that is there, params the page refuses, a name that is no data file; nothing is made", async () => {
    assert.match((await action("make", { id: "one" })).error ?? "", /nodes\.make: \/w\/one is there already/);
    assert.match((await action("make", { id: "nope" })).error ?? "", /returned null/);
    assert.ok(!existsSync(join(app.root, "w/nope")));
    for (const file of ["page.tsx", "_x.json", ".hidden", "a/b.json"]) {
      assert.match((await action("make", { id: "four", data: { [file]: "x" } })).error ?? "", /invalid data file/, file);
      assert.ok(!existsSync(join(app.root, "w/four")), file);
    }
    assert.match((await action("make", { id: "../w" })).error ?? "", /./);
  });
});
