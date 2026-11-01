// An agent's plan, read from its conversation (bridge/src/plan.ts, SPEC 13.16): the plan it proposed and how that
// stands (Claude Code's ExitPlanMode: asking, approved, declined; a Codex plan item: proposed), and its list of steps
// (TodoWrite and update_plan each give the whole list; TaskCreate and TaskUpdate change it one task at a time). The
// bridge reads only what each call's runner says it does (its toolMetadata, SPEC 13.18): the calls here carry what the
// claude and codex runners' tables say of them (test/lib/tools.ts), so this checks the tables and the reading together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planOf, stepsAfter, stepsChangeOf } from "../../packages/bridge/src/plan.ts";
import { metaFor } from "../lib/tools.ts";

type UIMessage = Parameters<typeof planOf>[0][number];
type Part = UIMessage["parts"][number];
let n = 0;
const call = (toolName: string, input: unknown, state: "input-available" | "output-available" | "output-error" = "output-available", output: unknown = "ok"): Part => {
  const toolMetadata = metaFor(toolName, input, state === "output-available" ? output : undefined);
  return (state === "output-error"
    ? { type: "dynamic-tool", toolName, toolCallId: `c${++n}`, state, input, errorText: String(output), toolMetadata }
    : state === "output-available"
      ? { type: "dynamic-tool", toolName, toolCallId: `c${++n}`, state, input, output, toolMetadata }
      : { type: "dynamic-tool", toolName, toolCallId: `c${++n}`, state, input, toolMetadata }) as Part;
};
const reply = (...parts: Part[]): UIMessage => ({ id: `m${++n}`, role: "assistant", parts });
const ask = (text: string): UIMessage => ({ id: `m${++n}`, role: "user", parts: [{ type: "text", text }] });

test("no plan: a conversation without one", () => {
  assert.deepEqual(planOf([ask("hi"), reply({ type: "text", text: "hello" } as Part)]), { proposal: null, steps: null });
});

test("TodoWrite: the whole list each time, the one under way by what it is doing", () => {
  const todos = (s: string[]) => ({ todos: [["Read it", s[0]], ["Fix it", s[1]]].map(([content, status]) => ({ content, status, activeForm: `${content}ing` })) });
  const plan = planOf([ask("fix"), reply(call("TodoWrite", todos(["in_progress", "pending"]))), reply(call("TodoWrite", todos(["completed", "in_progress"])))]);
  assert.deepEqual(plan.steps, [
    { text: "Read it", status: "done" },
    { text: "Fix iting", status: "active" },
  ]);
});

test("update_plan (Codex): its steps and why", () => {
  const plan = planOf([reply(call("update_plan", { explanation: "Two steps", plan: [{ step: "Look", status: "completed" }, { step: "Change", status: "inProgress" }, { step: "Test", status: "pending" }] }))]);
  assert.deepEqual(plan.steps?.map((s) => s.status), ["done", "active", "pending"]);
  assert.equal(plan.explanation, "Two steps");
});

test("TaskCreate / TaskUpdate: one task at a time, by the number its result gave", () => {
  const steps = stepsAfter([
    call("TaskCreate", { subject: "Read" }, "output-available", "Task #1 created successfully: Read"),
    call("TaskCreate", { subject: "Fix" }, "output-available", "Task #2 created successfully: Fix"),
    call("TaskCreate", { subject: "Gone" }, "output-available", "Task #3 created successfully: Gone"),
    call("TaskUpdate", { taskId: "1", status: "completed" }),
    call("TaskUpdate", { taskId: "2", status: "in_progress", subject: "Fix truncate" }),
    call("TaskUpdate", { taskId: "3", status: "deleted" }),
    call("TaskUpdate", { taskId: "9", status: "completed" }), // no such task: nothing
  ]);
  assert.deepEqual(steps?.steps, [
    { text: "Read", status: "done" },
    { text: "Fix truncate", status: "active" },
  ]);
});

test("ExitPlanMode: asking, approved, declined; the latest proposal wins", () => {
  const plan = (state: "input-available" | "output-available" | "output-error") => planOf([reply(call("ExitPlanMode", { plan: "## A\n1. x" }, state, "The user did not approve the plan yet"))]).proposal?.state;
  assert.equal(plan("input-available"), "asking");
  assert.equal(plan("output-available"), "approved");
  assert.equal(plan("output-error"), "declined");
  const two = planOf([reply(call("ExitPlanMode", { plan: "first" }, "output-error", "no")), ask("change it"), reply(call("ExitPlanMode", { plan: "second" }, "input-available"))]);
  assert.equal(two.proposal?.text, "second");
  assert.equal(two.proposal?.state, "asking");
  // Without a plan's text, it is no proposal.
  assert.equal(planOf([reply(call("ExitPlanMode", {}, "input-available"))]).proposal, null);
});

test("a Codex plan item: proposed (nothing to approve)", () => {
  const item = call("plan", { plan: "1. look\n2. change" });
  assert.deepEqual(planOf([reply(item)]).proposal, { id: (item as { toolCallId: string }).toolCallId, text: "1. look\n2. change", state: "proposed" });
});

test("a call no runner said anything of: nothing (the bridge knows no harness's names)", () => {
  const bare = { type: "dynamic-tool", toolName: "TodoWrite", toolCallId: "bare", state: "output-available", input: { todos: [{ content: "x", status: "pending" }] }, output: "ok" } as Part;
  assert.deepEqual(planOf([reply(bare)]), { proposal: null, steps: null });
});

test("a step added without its number (before its result says it) is one past the highest, not its place: no clash after a delete", () => {
  const steps = stepsAfter([
    call("TaskCreate", { subject: "A" }, "output-available", "Task #1 created successfully: A"),
    call("TaskCreate", { subject: "B" }, "output-available", "Task #2 created successfully: B"),
    call("TaskUpdate", { taskId: "1", status: "deleted" }),
    call("TaskCreate", { subject: "C" }, "input-available"), // its place would be 2: B's number
    call("TaskUpdate", { taskId: "2", status: "completed" }),
    call("TaskUpdate", { taskId: "3", status: "in_progress" }), // C, as Claude Code numbers it
  ]);
  assert.deepEqual(steps?.steps, [
    { text: "B", status: "done" },
    { text: "C", status: "active" },
  ]);
});

test("what one call changes: the whole list, one more, one changed; none for another call", () => {
  assert.ok("set" in stepsChangeOf(call("TodoWrite", { todos: [{ content: "x", status: "pending", activeForm: "x" }] }))!);
  assert.deepEqual(stepsChangeOf(call("TaskCreate", { subject: "Read" }, "output-available", "Task #4 created successfully: Read")), { add: { text: "Read", status: "pending", id: "4" } });
  assert.deepEqual(stepsChangeOf(call("TaskUpdate", { taskId: "4", status: "completed" })), { update: { id: "4", status: "done" } });
  assert.equal(stepsChangeOf(call("Bash", { command: "ls" })), null);
});

test("planOf reads a message again only when it is another object (a reply streaming in), not the whole conversation each time", () => {
  const first = reply(call("ExitPlanMode", { plan: "one" }, "output-available"));
  const second = reply(call("TodoWrite", { todos: [{ content: "Read", status: "in_progress", activeForm: "Reading" }] }));
  assert.equal(planOf([first, second]).proposal?.text, "one");
  // The same objects: what was read of them holds (a part changed in place is not seen; useChat never does that).
  (first.parts[0] as unknown as { toolMetadata: { plan: string } }).toolMetadata.plan = "changed in place";
  assert.equal(planOf([first, second]).proposal?.text, "one");
  // A new object for the message that changed: read again.
  const streamed = { ...second, parts: [...second.parts, call("ExitPlanMode", { plan: "two" }, "input-available")] };
  const after = planOf([first, streamed]);
  assert.equal(after.proposal?.text, "two");
  assert.equal(after.proposal?.state, "asking");
  assert.deepEqual(after.steps, [{ text: "Reading", status: "active" }]);
});
