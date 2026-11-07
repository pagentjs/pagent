// The node a server starts things with (core/src/program.ts): an update of node (Homebrew removes a library the old one
// needs) leaves a running server's own path dead on the way up, and what it starts then takes the first node on PATH; a
// process that dies before reading its input does not take the server with it.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { invoke } from "../../packages/core/src/agents/runner.ts";

const dir = mkdtempSync(join(tmpdir(), "pagent-node-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (tag: string) => import(`../../packages/core/src/program.ts?${tag}`) as Promise<typeof import("../../packages/core/src/program.ts")>;

/** Run `f` with PAGENT_NODE_BIN and PATH set; a warning is kept, not printed. */
async function withEnv<T>(node: string, path: string, f: () => T | Promise<T>): Promise<{ value: T; warned: string[] }> {
  const was = { node: process.env.PAGENT_NODE_BIN, path: process.env.PATH, warn: console.warn };
  const warned: string[] = [];
  process.env.PAGENT_NODE_BIN = node;
  process.env.PATH = path;
  console.warn = (m: string) => warned.push(m);
  try {
    return { value: await f(), warned };
  } finally {
    was.node === undefined ? delete process.env.PAGENT_NODE_BIN : (process.env.PAGENT_NODE_BIN = was.node);
    process.env.PATH = was.path;
    console.warn = was.warn;
  }
}

test("a node that runs is used; one that does not start gives way to the first on PATH, and says so", async () => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const dead = join(dir, "dead-node");
  writeFileSync(dead, `#!/bin/sh\nkill -ABRT $$\n`); // as a node whose library went: killed on the way up
  chmodSync(dead, 0o755);

  const live = await withEnv(process.execPath, bin, async () => (await fresh("live")).nodeBin());
  assert.equal(live.value, process.execPath);
  assert.deepEqual(live.warned, []);

  const gone = await withEnv(dead, bin, async () => {
    const { nodeBin, nodeProgram } = await fresh("gone");
    return { first: nodeBin(), again: nodeBin(), program: nodeProgram() };
  });
  assert.equal(gone.value.first, realpathSync(process.execPath));
  assert.equal(gone.value.again, gone.value.first);
  assert.ok(gone.value.program.includes(realpathSync(process.execPath)));
  assert.equal(gone.warned.length, 1);
  assert.match(gone.warned[0], /does not start any more .*dead-node/);
});

test("a dead node and none on PATH: it stays, and says so", async () => {
  const dead = join(dir, "dead-too");
  writeFileSync(dead, `#!/bin/sh\nexit 1\n`);
  chmodSync(dead, 0o755);
  const r = await withEnv(dead, join(dir, "nowhere"), async () => (await fresh("none")).nodeBin());
  assert.equal(r.value, dead);
  assert.match(r.warned[0], /no other on PATH/);
});

test("a runner that exits before reading its input (EPIPE) ends the call; nothing is thrown at the server", async () => {
  const script = join(dir, "quits.mjs");
  writeFileSync(script, "process.exit(3);\n");
  const code = await invoke(script, { big: "x".repeat(8_000_000) }, dir, () => {}, undefined, process.env);
  assert.equal(code, 3);
});
