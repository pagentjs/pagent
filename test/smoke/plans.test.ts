// A plan to go ahead with (SPEC 13.16): Claude Code's ExitPlanMode comes to the app's permission hook, which asks with
// the plan itself (its input's, or the plan file it names), Approve / Keep planning or what to change. Approve allows
// it; Keep planning denies it with a message that keeps the agent planning; anything typed goes back as what to
// change. The fake runner's !ask posts the hook's body as Claude Code does. The history keeps how each one went.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { planOf } from "../../packages/bridge/src/plan.ts";
import { fakePage, testApp, until, type TestApp } from "../lib/app.ts";

describe("plans", () => {
  let app: TestApp;
  const ask = (message: string) => app.post<{ text: string }>("/_pagent/ask", { node: "/", agent: "bot", message }).then((r) => r.text);
  const card = () => until(async () => (await app.get("/_pagent/prompts")).questions.find((q: any) => q.node === "/"), "the plan's card");
  const PLAN = "## Fix truncate\n\n1. Read `src/text.ts`.\n2. Count the `…`.";
  const exitPlan = (input: unknown) => `!ask ExitPlanMode ${JSON.stringify(input)}`;
  before(async () => (app = await testApp({ "page.tsx": fakePage() })));
  after(() => app?.close());

  test("the card is the plan; Keep planning, what to change, Approve", async () => {
    let reply = ask(exitPlan({ plan: PLAN }));
    let q = await card();
    assert.equal(q.kind, "permission"); // shown on any page, as permissions are
    assert.equal(q.plan, PLAN);
    assert.equal(q.detail, undefined);
    assert.deepEqual(q.options, ["Approve", "Keep planning"]);
    assert.deepEqual(q.say, { question: { key: "ask.plan" }, options: [{ key: "ask.planYes" }, { key: "ask.planKeep" }] });
    await app.post("/_pagent/answer", { id: q.id, answer: "Keep planning" });
    assert.equal(await reply, "denied ExitPlanMode: The user did not approve the plan yet: keep planning.");

    reply = ask(exitPlan({ plan: PLAN }));
    q = await card();
    await app.post("/_pagent/answer", { id: q.id, answer: "Split step 2 in two" });
    assert.equal(await reply, "denied ExitPlanMode: The user did not approve the plan yet. What they want changed: Split step 2 in two");

    reply = ask(exitPlan({ plan: PLAN }));
    q = await card();
    await app.post("/_pagent/answer", { id: q.id, answer: "Approve" });
    assert.equal(await reply, "allowed ExitPlanMode");

    // The conversation keeps how each went: the latest, approved.
    const { messages } = await app.get(`/_pagent/history?node=/&agent=bot`);
    const states = messages.flatMap((m: any) => m.parts).filter((p: any) => p.toolName === "ExitPlanMode").map((p: any) => p.state);
    assert.deepEqual(states, ["output-error", "output-error", "output-available"]);
    assert.deepEqual(planOf(messages).proposal && { text: planOf(messages).proposal!.text, state: planOf(messages).proposal!.state }, { text: PLAN, state: "approved" });
  });

  test("a plan in the plan file the request names", async () => {
    const file = join(app.root, "..", "plan.md");
    writeFileSync(file, "# From the file\n");
    const reply = ask(exitPlan({ planFilePath: file }));
    const q = await card();
    assert.equal(q.plan, "# From the file\n");
    await app.post("/_pagent/answer", { id: q.id, answer: "Approve" });
    assert.equal(await reply, "allowed ExitPlanMode");
  });

  test("only the option itself approves or allows: words that start with it are what to change, a no", async () => {
    let reply = ask(exitPlan({ plan: PLAN }));
    let q = await card();
    await app.post("/_pagent/answer", { id: q.id, answer: "Approve, but use pnpm" });
    assert.equal(await reply, "denied ExitPlanMode: The user did not approve the plan yet. What they want changed: Approve, but use pnpm");
    reply = ask('!ask Bash {"command":"make"}');
    q = await card();
    await app.post("/_pagent/answer", { id: q.id, answer: "allow it, but not in src/" });
    assert.equal(await reply, "denied Bash: The user declined: allow it, but not in src/.");
  });

  test("a harness process older than the server (the hook's own shape): told no at once, no card", async () => {
    const r = await app.post<any>("/_pagent/permission?node=/&agent=bot", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "make" } });
    assert.equal(r.hookSpecificOutput.decision.behavior, "deny");
    assert.match(r.hookSpecificOutput.decision.message, /older than the server: restart its agents \(pagent daemon restart\)/);
    assert.equal(r.decision.allow, false);
    assert.deepEqual((await app.get("/_pagent/prompts")).questions, []);
    assert.match(app.log(), /this harness process is older than the server/);
  });

  test("another tool's permission is as it was", async () => {
    const reply = ask('!ask Bash {"command":"make"}');
    const q = await card();
    assert.equal(q.plan, undefined);
    assert.equal(q.detail, "make");
    assert.deepEqual(q.options, ["Allow", "Deny"]);
    await app.post("/_pagent/answer", { id: q.id, answer: "Deny" });
    assert.equal(await reply, "denied Bash: The user declined.");
  });
});
