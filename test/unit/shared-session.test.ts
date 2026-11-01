// Two agents of a node that work in its folder (no cwd, no sessionId) share a session only on one harness that keeps
// sessions by folder (Claude Code's --continue): a Claude agent and a Codex agent there do not, nor agents of a runner
// that keeps a session per agent (its describe: sessions "agent"). A runner that does not say is taken as by folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Nodes } from "../../packages/core/src/nodes.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pagent-shared-")));
const root = join(base, "app");
after(() => rmSync(base, { recursive: true, force: true }));

const runner = (sessions?: string) =>
  `let s = ""; for await (const c of process.stdin) s += c;\nif (JSON.parse(s).op === "describe") process.stdout.write(JSON.stringify({ type: "describe", harness: { id: "own", title: "Own" }, turns: "headless", ops: [], interject: false${sessions ? `, sessions: "${sessions}"` : ""} }) + "\\n");\n`;
const page = (agents: Record<string, Record<string, unknown>>) => `export const agents = ${JSON.stringify(agents)};\nexport default function P() { return null; }\n`;

test("a shared session: only two agents in the folder on one harness that keeps sessions by folder", async () => {
  mkdirSync(join(root, "_runners"), { recursive: true });
  writeFileSync(join(root, "_runners", "per-agent.ts"), runner("agent"));
  writeFileSync(join(root, "_runners", "silent.ts"), `let s = ""; for await (const c of process.stdin) s += c;\n`); // says nothing of itself
  const nodes: Record<string, Record<string, Record<string, unknown>>> = {
    mixed: { analyst: { cli: "claude" }, second: { cli: "codex" } },
    twins: { a: { cli: "claude" }, b: { cli: "claude" }, c: { cli: "claude", sessionId: "s-1" } },
    models: { grok: { runner: "~/_runners/per-agent.ts" }, agy: { runner: "~/_runners/per-agent.ts" }, opencode: { runner: "~/_runners/per-agent.ts" } },
    silent: { x: { runner: "~/_runners/silent.ts" }, y: { runner: "~/_runners/silent.ts" } },
  };
  for (const [name, agents] of Object.entries(nodes)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "page.tsx"), page(agents));
  }
  const n = new Nodes(root);
  const errors = async (path: string) => (await n.info(path)).manifest.errors;
  assert.deepEqual(await errors("/mixed"), []);
  assert.deepEqual(await errors("/models"), []);
  const [twins] = await errors("/twins");
  assert.match(twins, /^agents a, b work in the node's folder on Claude Code, so they would share its session there/);
  const [silent] = await errors("/silent");
  assert.match(silent, /^agents x, y work in the node's folder on silent, .*sessions: "agent"/);
});
