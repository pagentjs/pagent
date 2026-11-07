// A chat's history merge keeps the ids of what it shows (bug b: a reply shown twice, or mounted again, when the
// transcript's copy of it arrived under another id); the server's history ends at a running turn's message.
import assert from "node:assert/strict";
import { test } from "node:test";
type UIMessage = Parameters<typeof mergeHistory>[0][number];
import { mergeHistory, shownIds } from "../../packages/bridge/src/history.ts";
import { callerOf, toolCallOf, untilRun, viewMessage, viewPart, type Run } from "../../packages/core/src/agents.ts";

const user = (id: string, text: string, origin?: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }], ...(origin ? { metadata: { origin } } : {}) });
const reply = (id: string, ...texts: string[]): UIMessage => ({ id, role: "assistant", parts: texts.map((text) => ({ type: "text" as const, text, state: "done" as const })) });
const idsOf = (ms: UIMessage[]) => ms.map((m) => m.id);

test("a live turn keeps its ids when the transcript's copy arrives (partial load)", () => {
  const ids = shownIds();
  const shown = mergeHistory([], [user("h1", "hi"), reply("h2", "hello")], undefined, ids);
  const live = [...shown, user("c1", "what now?"), reply("c2", "this.")]; // sent from the chat, streamed
  const next = mergeHistory(live, [reply("h2", "hello"), user("h3", "what now?"), reply("h4", "this.")], "h2", ids);
  assert.deepEqual(idsOf(next), ["h1", "h2", "c1", "c2"]);
  assert.equal(next[3], live[3], "an unchanged message is the same object (not rendered again)");
  // The next load starts at the transcript's id of the last message, which the chat shows as c2.
  const later = mergeHistory(next, [reply("h4", "this.", "and more."), user("h5", "ok")], "h4", ids);
  assert.deepEqual(idsOf(later), ["h1", "h2", "c1", "c2", "h5"]);
  assert.deepEqual(later[3].parts.map((p: any) => p.text), ["this.", "and more."]);
});

test("a whole reload keeps the ids too; the (from …) prefix does not matter", () => {
  const ids = shownIds();
  const live = [user("c1", "(from /page) press it"), reply("c2", "pressed")];
  const next = mergeHistory(live, [user("h0", "earlier"), reply("h00", "yes"), user("h1", "press it", "/page"), reply("h2", "pressed")], undefined, ids);
  assert.deepEqual(idsOf(next), ["h0", "h00", "c1", "c2"]);
});

test("a message the transcript does not have yet stays out; one it never had is not matched by accident", () => {
  const ids = shownIds();
  const live = [user("c1", "first"), reply("c2", "one")];
  const next = mergeHistory(live, [user("h1", "something else"), reply("h2", "two")], undefined, ids);
  assert.deepEqual(idsOf(next), ["h1", "h2"]); // a reply after a user message that did not line up is not guessed at
  const again = mergeHistory([], [user("x", "a")], undefined, shownIds());
  assert.deepEqual(idsOf(again), ["x"]);
});

test("two messages steered into one turn (Codex): both user messages keep their ids, the turn's reply too", () => {
  const ids = shownIds();
  const live = [user("c1", "do A"), reply("c2", "on it"), user("c3", "and B"), reply("c4", "both done")];
  const next = mergeHistory(live, [user("h1", "do A"), user("h2", "and B"), reply("h3", "on it", "both done")], undefined, ids);
  assert.deepEqual(idsOf(next), ["c1", "c3", "c4"]);
});

test("the server's history while a turn runs: up to the turn's message, as the run has it", () => {
  const run = { user: user("run-user", "do it") } as Run;
  const h = [user("h1", "before"), reply("h2", "ok"), user("h3", "(from /x) do it"), reply("h4", "half of the rep")];
  assert.deepEqual(idsOf(untilRun(h, run)), ["h1", "h2", "run-user"]);
  assert.deepEqual(idsOf(untilRun(h.slice(0, 2), run)), ["h1", "h2", "run-user"]); // not in the transcript yet
  assert.equal(untilRun(h, undefined), h);
});

test("the caller's line, read by core from any runner's transcript: the message, with its caller", () => {
  const page: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "press it" }], metadata: { caller: { kind: "page", path: "/page" } } };
  assert.deepEqual(callerOf(user("u1", "(from /page) press it")), page);
  const codex: UIMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "(from trigger:/#check) look" }], metadata: { turnId: "t1" } };
  assert.deepEqual(callerOf(codex).metadata, { turnId: "t1", caller: { kind: "trigger", node: "/", name: "check" } });
  assert.equal(callerOf(user("u3", "plain words")).metadata, undefined);
  const task: UIMessage = { id: "u4", role: "user", parts: [{ type: "text", text: "(from /x) y" }], metadata: { kind: "background" } }; // the runner said what it is
  assert.equal(callerOf(task), task);
  const answer = reply("a1", "(from /page) not a user message");
  assert.equal(callerOf(answer), answer);
});

test("a view's part: the last turns, earlier ones before a message, or from a message on", () => {
  const ms = [reply("r0", "hello"), user("u1", "a"), reply("r1", "A"), user("u2", "b"), reply("r2", "B1"), reply("r2b", "B2"), user("u3", "c"), reply("r3", "C")];
  const last2 = viewPart(ms, { turns: 2 });
  assert.deepEqual(idsOf(last2.messages), ["u2", "r2", "r2b", "u3", "r3"], "whole turns, from the message that starts one");
  assert.equal(last2.earlier, 3);
  const before = viewPart(ms, { before: "u2", turns: 2 });
  assert.deepEqual(idsOf(before.messages), ["r0", "u1", "r1"], "fewer turns there: from the beginning");
  assert.equal(before.earlier, 0);
  assert.deepEqual(viewPart(ms, { after: "r2b", turns: 1 }), { messages: ms.slice(5), earlier: 5 }, "after: from it on, however many turns");
  assert.deepEqual(idsOf(viewPart(ms, { after: "gone", turns: 1 }).messages), ["u3", "r3"], "after a message no longer there: the last turns");
  assert.deepEqual(viewPart(ms, { before: "gone", turns: 1 }), { messages: [], earlier: 0 });
  assert.deepEqual(viewPart(ms, { turns: 10 }), { messages: ms, earlier: 0 });
});

test("a view's message: a few lines of each piece of a tool call, the rest whole; the call as it is, by its id", () => {
  const big = "x".repeat(1000);
  const cut = "x".repeat(300) + "\n… (700 more characters)";
  const call = { type: "dynamic-tool", toolName: "Bash", toolCallId: "t1", state: "output-available", input: { command: big, n: 3 }, output: { lines: [big] }, toolMetadata: { kind: "command", command: big } };
  const form = { ...call, toolCallId: "t3", toolMetadata: { kind: "command", command: `pagent ask-user --field ${big}` } };
  const plan = { ...call, toolCallId: "t4", toolMetadata: { kind: "proposal", plan: big } };
  const m = { id: "r", role: "assistant", parts: [{ type: "text", text: big }, call, { type: "data-subagent-step", id: "s:1", data: { of: "t0", part: { ...call, toolCallId: "t2" } } }, form, plan] } as unknown as UIMessage;
  const v = viewMessage(m) as any;
  assert.equal(v.parts[0].text, big, "what the conversation says stays whole");
  assert.deepEqual(v.parts[1].input, { command: cut, n: 3 });
  assert.equal(v.parts[1].output, JSON.stringify({ lines: [big] }, null, 2).slice(0, 300) + `\n… (${JSON.stringify({ lines: [big] }, null, 2).length - 300} more characters)`, "as a card lays it out");
  assert.equal(v.parts[1].toolMetadata.command, cut);
  assert.equal(v.parts[2].data.part.input.command, cut, "a sub-agent's call too");
  assert.equal(v.parts[3].toolMetadata.command, `pagent ask-user --field ${big}`, "a form's command is read by its card: whole");
  assert.equal(v.parts[4].toolMetadata.plan, big, "what the runner says of a call (a plan) stays whole");
  assert.equal((m.parts[1] as any).input.command, big, "the history itself is not changed");
  const plain = user("u", "hi");
  assert.equal(viewMessage(plain), plain);
  assert.deepEqual(toolCallOf([m], "t2"), { input: { command: big, n: 3 }, output: { lines: [big] }, errorText: undefined });
  assert.equal(toolCallOf([m], "nope"), null);
});
