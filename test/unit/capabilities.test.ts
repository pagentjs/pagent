// What a runner says it does (core/src/agents/runner.ts, its describe op): asked once and kept, unless it failed, which
// is asked again next time (not taken for what it is not until the server restarts). describe is optional: a runner
// that runs and says nothing of itself is a minimal headless one (ask, history), named by its file.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { capabilitiesOf, canDo, harnesses } from "../../packages/core/src/agents/runner.ts";
import type { AgentDecl } from "../../packages/core/src/extract.ts";

const dir = mkdtempSync(join(tmpdir(), "pagent-capabilities-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const decl = (runner: string) => ({ name: "main", runner }) as AgentDecl;

test("a describe that failed is asked again; one that answered is kept", async () => {
  const broken = join(dir, "broken");
  const count = join(dir, "count");
  const script = join(dir, "flaky.ts");
  writeFileSync(
    script,
    `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(count)}, "x");
if (existsSync(${JSON.stringify(broken)})) process.exit(1);
process.stdout.write(JSON.stringify({ type: "describe", harness: { id: "flaky", title: "Flaky" }, turns: "headless", ops: ["usage"], interject: false }) + "\\n");
`,
  );
  chmodSync(script, 0o755);
  writeFileSync(broken, "");
  const first = await capabilitiesOf(decl(script));
  assert.equal(first.ops.has("usage"), false, "it said nothing: what every headless runner does, for now");
  rmSync(broken);
  const second = await capabilitiesOf(decl(script));
  assert.deepEqual([second.harness.id, second.ops.has("usage"), second.ops.has("history")], ["flaky", true, true], "asked again");
  await capabilitiesOf(decl(script));
  assert.equal(readFileSync(count, "utf8"), "xx", "kept once it answered");
});

test("a runner without describe (ask and history only) is a headless runner named by its file", async () => {
  const script = join(dir, "cli.ts");
  writeFileSync(
    script,
    `let s = ""; for await (const c of process.stdin) s += c;
const input = JSON.parse(s);
if (input.op === "ask") process.stdout.write(JSON.stringify({ type: "data-result", data: { text: "hi" } }) + "\\n");
else if (input.op === "history") process.stdout.write(JSON.stringify({ type: "history", messages: [] }) + "\\n");
`,
  );
  const caps = await capabilitiesOf(decl(script));
  assert.deepEqual([caps.harness.id, caps.turns, [...caps.ops].sort()], ["cli", "headless", ["ask", "describe", "history"]]);
  assert.equal(await canDo(decl(script), "history"), true);
  assert.equal(await canDo(decl(script), "usage"), false);
  const missing = await capabilitiesOf(decl(join(dir, "nowhere.ts")));
  assert.equal(missing.ops.size, 0, "a runner that is not there can do nothing");
  assert.ok((await harnesses()).every((h) => h.id !== "cli"), "not a harness of the engine's");
});
