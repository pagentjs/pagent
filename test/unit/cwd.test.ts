// An agent's declared cwd, relative: "~/…" from the app's root (a folder beside the app: "~/../agents/ops"), anything
// else from its node's folder; absolute ones as written. A runner script of the app's own, the same way.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cwdFrom, isRunnerPath, Nodes } from "../../packages/core/src/nodes.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pagent-cwd-")));
const root = join(base, "app");
after(() => rmSync(base, { recursive: true, force: true }));

test("cwdFrom: ~ from the app's root, the rest from the node's folder", () => {
  assert.equal(cwdFrom("/d/app", "/d/app/ops", "~"), "/d/app");
  assert.equal(cwdFrom("/d/app", "/d/app/ops", "~/../agents/ops"), "/d/agents/ops");
  assert.equal(cwdFrom("/d/app", "/d/app/ops", "work"), "/d/app/ops/work");
  assert.equal(cwdFrom("/d/app", "/d/app/ops", "../shared"), "/d/app/shared");
});

test("declarations give the agents' cwds absolute", async () => {
  mkdirSync(join(root, "ops"), { recursive: true });
  writeFileSync(join(root, "page.tsx"), `export const agents = { manager: { cli: "claude", cwd: "~/.." } };\nexport default function P() { return null; }\n`);
  writeFileSync(
    join(root, "ops", "page.tsx"),
    `export const agents = { ops: { cli: "claude", cwd: "~/../agents/ops" }, here: { cli: "claude", cwd: "notes" }, there: { cli: "claude", cwd: "/srv/x" } };\nexport default function P() { return null; }\n`,
  );
  const nodes = new Nodes(root);
  const cwds = async (path: string) => Object.fromEntries((await nodes.declarations(path)).manifest.agents.map((a) => [a.name, a.cwd]));
  assert.deepEqual(await cwds("/"), { manager: base });
  assert.deepEqual(await cwds("/ops"), { ops: join(base, "agents/ops"), here: join(root, "ops/notes"), there: "/srv/x" });
});

test("a runner of the app's own, by a relative path: ~ from the app's root, else beside its node; names stay names", async () => {
  assert.equal(isRunnerPath("claude"), false);
  assert.equal(isRunnerPath("claude:sonnet"), false);
  for (const p of ["~/_runners/cli.ts", "./cli.ts", "_runners/cli.ts", "cli.mjs", "/srv/cli.ts"]) assert.equal(isRunnerPath(p), true, p);
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(
    join(root, "models", "page.tsx"),
    `export const agents = { grok: { runner: "~/_runners/cli.ts" }, mine: { runner: "./mine.ts" }, there: { runner: "/srv/cli.ts" }, cc: { cli: "claude" } };\nexport default function P() { return null; }\n`,
  );
  const nodes = new Nodes(root);
  const runners = Object.fromEntries((await nodes.declarations("/models")).manifest.agents.map((a) => [a.name, a.runner]));
  assert.deepEqual(runners, { grok: join(root, "_runners/cli.ts"), mine: join(root, "models/mine.ts"), there: "/srv/cli.ts", cc: "claude" });
});
