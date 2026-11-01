// Small pieces of the runners (packages/runners/src/lib) that decide what the app sees: an ExitPlanMode's plan, live and
// in a transcript (claude-tools.ts); what an opencode agent may run without asking (opencode-export.ts); an ACP
// session's token use as it goes and the end of its record (acp-record.ts).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { addUsage, lastOf, readRecord, readTail, usageOf, type Seen } from "../../packages/runners/src/lib/acp-record.ts";
import { claudeTool, claudeToolLive } from "../../packages/runners/src/lib/claude-tools.ts";
import { opencodePermission } from "../../packages/runners/src/lib/opencode-export.ts";

const dir = mkdtempSync(join(tmpdir(), "pagent-runners-lib-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("ExitPlanMode: live, the plan file as it is now; in a transcript, what the call carried, never today's file", () => {
  const file = join(dir, "plan.md");
  writeFileSync(file, "# Today's plan\n");
  const input = { planFilePath: file };
  assert.equal(claudeToolLive("ExitPlanMode", input).plan, "# Today's plan\n", "the permission card, the live turn");
  assert.equal(claudeTool("ExitPlanMode", input).plan, "", "a rejected proposal in history: not today's plan");
  const approved = "User has approved your plan. You can now start coding.\n\n## Approved Plan:\n# Monday's plan\n1. read\n";
  assert.equal(claudeTool("ExitPlanMode", input, approved).plan, "# Monday's plan\n1. read");
  assert.equal(claudeTool("ExitPlanMode", { plan: "# In the input" }, approved).plan, "# In the input");
  assert.equal(claudeToolLive("Bash", { command: "ls" }).kind, "command");
});

test("opencode: the commands that need no asking are those commands, not every command that starts with their letters", () => {
  const p = opencodePermission(["Bash(curl:*)", "Bash(make test)", "WebFetch"]);
  // opencode's patterns: "*" is any text; the last pattern that matches wins.
  const decide = (cmd: string) => {
    let d = "";
    for (const [pattern, v] of Object.entries(p.bash)) if (new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(cmd)) d = v;
    return d;
  };
  for (const cmd of ["git diff", "git diff --stat", "git status", "git log -3", "git commit -m x", "pagent agents", "pagent", "curl example.com", "make test"]) assert.equal(decide(cmd), "allow", cmd);
  for (const cmd of ["git difftool -x 'rm -rf ~' HEAD", "git logx", "git showx", "pagentx", "curlx --evil", "make test && rm -rf /", "npm i"]) assert.equal(decide(cmd), "ask", cmd);
  assert.equal(p.webfetch, "allow");
  assert.equal(opencodePermission([]).webfetch, "ask");
  assert.equal(opencodePermission(["Bash"]).bash["*"], "allow");
});

test("ACP: the token use as it goes is the record's; the end of the record says where it stopped", () => {
  const record: Seen[] = [
    { t: 1, user: { id: "u1", text: "hi" } },
    { t: 2, u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first answer" } } },
    { t: 3, end: { stopReason: "end_turn", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 } } },
    { t: 4, u: { sessionUpdate: "usage_update", used: 900, size: 200_000 } },
    { t: 5, user: { id: "u2", text: "again" } },
    { t: 6, u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second answer" } } },
    { t: 7, end: { stopReason: "end_turn", usage: { input: 20, output: 7, cacheRead: 3, cacheWrite: 1 } } },
  ];
  let u = null;
  for (const s of record) u = addUsage(u, s);
  assert.deepEqual(u, usageOf(record));
  assert.deepEqual([u!.input, u!.output, u!.cacheRead, u!.context, u!.window], [30, 12, 5, 24, 200_000]);
  assert.equal("requests" in u!, false, "ACP says turns, not requests");

  const file = join(dir, "s.jsonl");
  for (const s of record) appendFileSync(file, JSON.stringify(s) + "\n");
  const whole = readTail(file);
  assert.equal(whole.whole, true);
  assert.deepEqual(whole.seen, readRecord(file));
  // A long record: its tail, from the first message in it (a turn whole).
  for (let i = 0; i < 2000; i++) appendFileSync(file, JSON.stringify({ t: 10 + i, u: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x".repeat(100) } } }) + "\n");
  appendFileSync(file, JSON.stringify({ t: 5000, user: { id: "u3", text: "last" } }) + "\n" + JSON.stringify({ t: 5001, u: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the last answer" } } }) + "\n");
  const tail = readTail(file, 4096);
  assert.equal(tail.whole, false);
  assert.ok("user" in tail.seen[0]);
  assert.equal(lastOf(tail.seen).text, "the last answer");
  assert.equal(lastOf(tail.seen).lastAt, new Date(5001).toISOString());
});
